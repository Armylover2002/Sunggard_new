
import PorterPayment from "../../models/porterPayment.js";
import Parcel from "../../models/parcel.js";
import {
  PORTER_BOOKING_KIND,
  PORTER_PAYER_TYPE,
  PORTER_PAYMENT_PURPOSE,
  PORTER_PAYMENT_SOURCE,
  PORTER_PAYMENT_STATUS,
  PORTER_OPEN_STATUSES,
  bookingPaymentStatusFor,
  canTransitionPorterPayment,
} from "../../constants/porterPayment.js";
import { getActivePaymentProvider } from "../payment/providerRegistry.js";
import { gstFromBreakdown } from "../../utils/gst.js";
import logger from "../logger.js";

/**
 * The gateway lifecycle for every porter payment.
 *
 * What this replaces: two loose strings on the booking document
 * (`razorpayOrderId`, `razorpayPaymentId`), a four-value `paymentStatus`
 * flipped straight to PAID on a signature check, and no webhook at all. That
 * arrangement had four concrete failures in production terms:
 *
 *   1. A valid signature proves the RECEIPT is genuine. It does not prove the
 *      money was captured. Authorised-but-uncaptured payments were being
 *      treated as paid, and a rider was dispatched against them.
 *   2. A customer whose browser or app died between paying and returning had,
 *      as far as the database was concerned, not paid. The money sat in the
 *      Razorpay account with no booking attached to it.
 *   3. A failure, a refund, a chargeback or a late capture had nowhere to be
 *      recorded, so support had to read the Razorpay dashboard to answer any
 *      question about any payment.
 *   4. Nothing was idempotent. A retried verify or a redelivered event would
 *      re-run every side effect, including starting a second rider broadcast.
 *
 * The shape here mirrors `services/paymentService.js`, which does the same
 * job for marketplace orders, on purpose: one mental model, one provider
 * adapter, one webhook route. It is a separate service rather than an
 * extension of that one because a porter booking has no Order, no seller and
 * no stock to release, and forcing it through a settlement path built around
 * all three is how both break.
 */

/* ==========================================================================
   Booking access — the one place that knows the two collections apart
   ========================================================================== */

const BOOKINGS = {
  [PORTER_BOOKING_KIND.PARCEL]: {
    model: Parcel,
    label: "Courier",
    reference: (doc) => `PCL-${String(doc._id).slice(-6).toUpperCase()}`,
  },
};

function bookingAccessor(kind) {
  const entry = BOOKINGS[kind];
  if (!entry) {
    const err = new Error(`Unknown courier booking kind: ${kind}`);
    err.statusCode = 400;
    throw err;
  }
  return entry;
}

const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);

/* ==========================================================================
   Snapshots
   ========================================================================== */

/**
 * Everything an invoice needs, frozen at the moment of sale.
 *
 * Copied rather than referenced because a rate card is editable and an
 * invoice is not. A booking re-rendered a year from now has to show what was
 * actually charged, not what the current config would charge.
 */
function buildBookingSnapshot(kind, booking) {
  return {
    kind,
    pickup: booking.pickupAddress,
    drop: booking.dropAddress,
    package: booking.packageDetails,
    courierCompany: booking.courierCompany,
    destinationCity: booking.destinationCity,
    parcelType: booking.parcelType,
    distanceKm: booking.distance,
    deliverySpeed: booking.deliverySpeed,
    pickupWindow: booking.pickupWindow,
    preferredPickupDate: booking.preferredPickupDate,
    courierCompanyId: booking.courierCompanyId ? String(booking.courierCompanyId) : null,
    bookedAt: booking.createdAt,
  };
}

/** The tax that was charged, read off the booking rather than recomputed. */
function buildTaxSnapshot(booking) {
  const gst = gstFromBreakdown({
    ...(booking.fareBreakdown?.toObject?.() || booking.fareBreakdown || {}),
    fare: booking.fare,
  });
  return {
    gstEnabled: gst.gstEnabled,
    gstPercent: gst.gstPercent,
    gstin: gst.gstin,
    taxableAmount: gst.taxableAmount,
    cgst: gst.cgst,
    sgst: gst.sgst,
    igst: gst.igst,
    gstAmount: gst.gstAmount,
    placeOfSupply: "",
  };
}

/* ==========================================================================
   State machine
   ========================================================================== */

/**
 * Move a payment to a new status, or decline to.
 *
 * Returns whether it actually changed, because every caller has to know: the
 * side effects (marking a booking paid, starting a rider search) may only run
 * on a real transition. Running them on a repeat is what turns a redelivered
 * webhook into a second broadcast.
 *
 * A refused transition is logged and swallowed rather than thrown. Razorpay
 * genuinely does deliver `payment.failed` after `payment.captured` on a
 * retried checkout, and a 500 back to the gateway would make it retry the
 * same out-of-order event forever.
 */
export function applyPorterStatus(
  payment,
  { nextStatus, source, reason = "", gatewayState = "", gatewayEventId = null },
) {
  const current = payment.status;

  if (current === nextStatus) return false;

  if (!canTransitionPorterPayment(current, nextStatus)) {
    logger.warn("porter_payment_transition_refused", {
      paymentId: String(payment._id),
      from: current,
      to: nextStatus,
      source,
      reason,
    });
    return false;
  }

  payment.status = nextStatus;
  payment.statusHistory.push({
    fromStatus: current,
    toStatus: nextStatus,
    source,
    reason,
    gatewayState,
    gatewayEventId,
    at: new Date(),
  });

  const now = new Date();
  if (nextStatus === PORTER_PAYMENT_STATUS.AUTHORIZED) payment.authorizedAt = now;
  if (nextStatus === PORTER_PAYMENT_STATUS.CAPTURED) payment.capturedAt = now;
  if (nextStatus === PORTER_PAYMENT_STATUS.FAILED) payment.failedAt = now;
  if (
    nextStatus === PORTER_PAYMENT_STATUS.REFUNDED ||
    nextStatus === PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED
  ) {
    payment.refundedAt = now;
  }

  return true;
}

/**
 * Copy what the gateway told us about the instrument onto the payment.
 *
 * Best-effort by design: a webhook for an order that never reached a payment
 * carries none of this, and that is not an error.
 */
export function absorbGatewayEntity(payment, entity) {
  if (!entity || typeof entity !== "object") return;

  if (entity.id) payment.gatewayPaymentId = entity.id;
  if (Number.isFinite(Number(entity.fee))) payment.gatewayFee = Number(entity.fee) || 0;
  if (Number.isFinite(Number(entity.tax))) payment.gatewayTax = Number(entity.tax) || 0;

  const card = entity.card || {};
  payment.instrument = {
    method: entity.method || payment.instrument?.method || "",
    vpa: entity.vpa || entity.upi?.vpa || payment.instrument?.vpa || "",
    bank: entity.bank || payment.instrument?.bank || "",
    wallet: entity.wallet || payment.instrument?.wallet || "",
    cardLast4: card.last4 || payment.instrument?.cardLast4 || "",
    cardNetwork: card.network || payment.instrument?.cardNetwork || "",
    cardType: card.type || payment.instrument?.cardType || "",
    contact: entity.contact || payment.instrument?.contact || "",
    email: entity.email || payment.instrument?.email || "",
  };

  if (entity.error_code || entity.error_description) {
    payment.errorCode = entity.error_code || "";
    payment.errorDescription = entity.error_description || "";
    payment.errorStep = entity.error_step || "";
    payment.failureReason = entity.error_description || entity.error_reason || "";
  }

  if (Number.isFinite(Number(entity.amount_refunded))) {
    payment.refundedAmount = Number(entity.amount_refunded) || 0;
  }
}

/* ==========================================================================
   Opening a payment
   ========================================================================== */

/**
 * Our own reference, echoed to the gateway as the receipt and in notes.
 *
 * The gateway assigns its own order id, and a webhook may quote either — so
 * a payment has to be findable from both sides. Razorpay caps receipts at 40
 * characters, hence the truncation rather than a longer, prettier string.
 */
function buildMerchantReference(kind, bookingId, attempt) {
  const prefix = "PCL";
  const suffix = `A${Math.max(1, Number(attempt) || 1)}`;
  return `PTR-${prefix}-${String(bookingId).slice(-12)}-${suffix}`.slice(0, 40);
}

/**
 * Open (or re-use) a gateway order for a booking.
 *
 * Re-use is the important half. A customer who dismisses the checkout sheet
 * and taps Pay again must land on the SAME gateway order — opening a second
 * one against the same booking is precisely how somebody ends up paying
 * twice, and the partial unique index on the model refuses it at the database
 * level so this cannot be got wrong by a future caller either.
 */
export async function openBookingPayment({
  kind,
  booking,
  idempotencyKey = null,
  correlationId = null,
}) {
  const accessor = bookingAccessor(kind);
  // A coupon discount is charged to the customer's payable amount, never the
  // pre-discount `fare` — that field stays the basis for rider earning/GST
  // and is untouched by the discount.
  const amountPaise = toPaise(booking.payableFare || booking.fare);

  if (!(amountPaise > 0)) {
    const err = new Error("This booking has no amount to pay");
    err.statusCode = 400;
    throw err;
  }

  const provider = getActivePaymentProvider();
  if (!provider.isConfigured()) {
    const err = new Error(
      "Online payment is unavailable right now. Choose cash on pickup.",
    );
    err.statusCode = 503;
    err.code = "GATEWAY_NOT_CONFIGURED";
    throw err;
  }

  /**
   * A live attempt for the same amount is re-used outright. A live attempt
   * for a DIFFERENT amount cannot be — the fare changed under the customer
   * (an admin edited the rate card, or they changed the package) and paying
   * the old order would collect the wrong money. That one is cancelled and
   * replaced.
   */
  const open = await PorterPayment.findOne({
    bookingKind: kind,
    bookingId: booking._id,
    status: { $in: PORTER_OPEN_STATUSES },
  }).sort({ createdAt: -1 });

  if (open?.gatewayOrderId && open.amount === amountPaise) {
    return {
      payment: open,
      checkout: {
        orderId: open.gatewayOrderId,
        keyId: process.env.RAZORPAY_KEY_ID,
        amount: open.amount,
        currency: open.currency,
      },
      reused: true,
    };
  }

  if (open) {
    applyPorterStatus(open, {
      nextStatus: PORTER_PAYMENT_STATUS.CANCELLED,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: open.gatewayOrderId
        ? "Superseded — the fare changed before payment"
        : "Superseded — the gateway order was never opened",
    });
    await open.save();
  }

  const attemptCount =
    (await PorterPayment.countDocuments({ bookingKind: kind, bookingId: booking._id })) + 1;
  const merchantReference = buildMerchantReference(kind, booking._id, attemptCount);
  const referenceId = accessor.reference(booking);

  /**
   * The row is written BEFORE the gateway call, not after.
   *
   * If the gateway call succeeds and the insert then fails, a real Razorpay
   * order exists that this system has no record of — a customer can pay it
   * and nothing will ever match the money to a booking. Writing first means
   * the worst case is a CREATED row with no gateway order, which the
   * reconciler can see and close.
   */
  const payment = await PorterPayment.create({
    purpose: PORTER_PAYMENT_PURPOSE.BOOKING,
    bookingKind: kind,
    bookingId: booking._id,
    referenceId,
    payerType: PORTER_PAYER_TYPE.CUSTOMER,
    customerId: booking.customerId,
    gatewayName: provider.providerName,
    merchantReference,
    amount: amountPaise,
    currency: "INR",
    status: PORTER_PAYMENT_STATUS.CREATED,
    attemptCount,
    idempotencyKey: idempotencyKey || null,
    correlationId,
    fareSnapshot: booking.fareBreakdown?.toObject?.() || booking.fareBreakdown || {},
    taxSnapshot: buildTaxSnapshot(booking),
    bookingSnapshot: buildBookingSnapshot(kind, booking),
    notes: {
      porterBookingKind: kind,
      porterBookingId: String(booking._id),
      referenceId,
    },
  });

  try {
    const init = await provider.initiatePayment({
      merchantOrderId: merchantReference,
      amountPaise,
      currency: "INR",
      notes: {
        porterBookingKind: kind,
        porterBookingId: String(booking._id),
        referenceId,
        purpose: PORTER_PAYMENT_PURPOSE.BOOKING,
      },
    });

    payment.gatewayOrderId = init.gatewayOrderId;
    payment.rawGatewayResponse = { order: init.gatewayResponse };
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.PENDING,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: `${provider.providerName} checkout opened`,
    });
    await payment.save();

    logger.info("porter_payment_opened", {
      paymentId: String(payment._id),
      kind,
      bookingId: String(booking._id),
      referenceId,
      amount: amountPaise,
      correlationId,
    });

    return { payment, checkout: init.checkout, reused: false };
  } catch (error) {
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.FAILED,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: `Could not open the gateway order: ${error?.message || "unknown"}`,
    });
    payment.failureReason = error?.message || "Could not start the payment";
    await payment.save().catch(() => {});
    throw error;
  }
}

/* ==========================================================================
   Side effects
   ========================================================================== */

/**
 * What a status change means for the booking itself.
 *
 * Split from the state machine so that the client-verify path, the webhook
 * path and the reconciler all produce identical outcomes. Each of those used
 * to be either absent or hand-rolled.
 *
 * `onPaid` is supplied by the caller rather than imported, because "release
 * the booking to riders" lives in two different workflow services and
 * importing both here would tie the payment layer to the dispatch layer in
 * both directions.
 */
export async function applyBookingSideEffects(payment, { onPaid = null } = {}) {
  if (payment.purpose !== PORTER_PAYMENT_PURPOSE.BOOKING) return null;

  const accessor = bookingAccessor(payment.bookingKind);
  const nextBookingStatus = bookingPaymentStatusFor(payment.status);

  const booking = await accessor.model.findById(payment.bookingId);
  if (!booking) return null;

  // COD bookings that were converted, or paid another way, must not be
  // dragged back by a late event for an abandoned attempt.
  if (booking.paymentStatus === "PAID" && nextBookingStatus !== "REFUNDED") {
    return booking;
  }

  if (payment.isPaid()) {
    booking.paymentStatus = "PAID";
    booking.razorpayOrderId = payment.gatewayOrderId;
    booking.razorpayPaymentId = payment.gatewayPaymentId;
    await booking.save();

    const { recordPorterPaymentCaptured } = await import("./customerLedgerService.js");
    await recordPorterPaymentCaptured(payment);

    if (typeof onPaid === "function") {
      // A dispatch failure must not roll back a payment the gateway has
      // already taken. The booking is paid either way; a rider search that
      // did not start is recoverable, an unrecorded payment is not.
      try {
        return await onPaid(booking);
      } catch (error) {
        logger.error("porter_payment_post_paid_hook_failed", {
          paymentId: String(payment._id),
          bookingId: String(booking._id),
          message: error?.message,
        });
      }
    }
    return booking;
  }

  if (nextBookingStatus === "REFUNDED") {
    booking.paymentStatus = "REFUNDED";
    await booking.save();
    const { recordPorterRefund } = await import("./customerLedgerService.js");
    await recordPorterRefund(payment, payment.refundedAmount, "Gateway refund");
    return booking;
  }

  /**
   * A failed attempt leaves the booking PENDING, not FAILED.
   *
   * FAILED on the booking is terminal in the customer app — it renders as
   * "this booking is dead". A customer who typed the wrong UPI PIN has not
   * lost their booking; they have one failed attempt and can try again
   * against the same row. Only an explicit cancellation ends a booking.
   */
  return booking;
}

/* ==========================================================================
   Refunding — booking cancellation
   ========================================================================== */

/**
 * Refund whatever is still captured against a booking, in full.
 *
 * Called right after a booking is cancelled — by the customer or an admin —
 * so a customer who paid online never has to separately ask for their money
 * back. Deliberately a no-op, not an error, for a booking that was never paid
 * online (COD) or was never paid at all: cancellation must always succeed on
 * its own terms, and the caller decides whether "nothing to refund" is worth
 * mentioning to whoever cancelled it.
 *
 * A gateway failure here (network blip, Razorpay outage) is caught and
 * recorded on the payment row rather than thrown — the booking is already
 * cancelled by the time this runs, and there is no sensible way to "undo" a
 * cancellation because a refund call timed out. The failure is written to
 * `refundFailureReason`/`refundFailedAt` and to the payment's own `refunds`
 * attempt log, so an admin looking at the booking sees a paid, cancelled
 * order with no successful refund rather than silence.
 */
export async function refundBookingPayment({
  kind,
  bookingId,
  reason = "Booking cancelled",
  source = PORTER_PAYMENT_SOURCE.SYSTEM,
  initiatedByAdminId = null,
}) {
  const payment = await PorterPayment.findOne({
    bookingKind: kind,
    bookingId,
    purpose: PORTER_PAYMENT_PURPOSE.BOOKING,
    status: { $in: [PORTER_PAYMENT_STATUS.CAPTURED, PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED] },
  }).sort({ capturedAt: -1 });

  // COD, never paid, or paid by an attempt this system has no record of —
  // there is genuinely nothing to send back.
  if (!payment) {
    return { attempted: false, reason: "NOT_PAID_ONLINE" };
  }

  if (!payment.gatewayPaymentId) {
    logger.error("porter_refund_missing_gateway_payment_id", {
      paymentId: String(payment._id),
      bookingKind: kind,
      bookingId: String(bookingId),
    });
    return { attempted: false, reason: "NO_GATEWAY_PAYMENT_ID" };
  }

  const remainingPaise = Math.max(0, payment.amount - (payment.refundedAmount || 0));
  if (remainingPaise <= 0) {
    return { attempted: false, reason: "ALREADY_REFUNDED", payment };
  }

  const provider = getActivePaymentProvider();

  try {
    const result = await provider.initiateRefund({
      gatewayPaymentId: payment.gatewayPaymentId,
      amountPaise: remainingPaise,
      notes: {
        reason,
        porterBookingKind: kind,
        porterBookingId: String(bookingId),
        referenceId: payment.referenceId,
      },
      receipt: `RFD-${payment.referenceId}`,
    });

    payment.refunds.push({
      gatewayRefundId: result.gatewayRefundId,
      amount: remainingPaise,
      status: result.status,
      reason,
      speed: result.speed || "",
      initiatedBy: initiatedByAdminId,
      createdAt: new Date(),
      processedAt: result.status === "processed" ? new Date() : null,
    });
    // The merchant balance is debited the moment the gateway accepts the
    // refund request, regardless of how long it takes to reach the
    // customer's bank — so this counts as refunded now, not once a later
    // webhook confirms it landed.
    payment.refundedAmount = Math.min(
      payment.amount,
      (payment.refundedAmount || 0) + remainingPaise,
    );
    payment.refundFailureReason = "";
    payment.refundFailedAt = null;
    payment.rawGatewayResponse = {
      ...(payment.rawGatewayResponse || {}),
      lastRefund: result.gatewayResponse,
    };

    const nextStatus =
      payment.refundedAmount >= payment.amount
        ? PORTER_PAYMENT_STATUS.REFUNDED
        : PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED;

    applyPorterStatus(payment, { nextStatus, source, reason });
    await payment.save();

    const booking = await applyBookingSideEffects(payment, {});

    logger.info("porter_refund_initiated", {
      paymentId: String(payment._id),
      bookingKind: kind,
      bookingId: String(bookingId),
      amount: remainingPaise,
      gatewayRefundId: result.gatewayRefundId,
      gatewayStatus: result.status,
    });

    return {
      attempted: true,
      ok: true,
      status: nextStatus,
      gatewayStatus: result.status,
      amountPaise: remainingPaise,
      amountRupees: Number((remainingPaise / 100).toFixed(2)),
      gatewayRefundId: result.gatewayRefundId,
      booking,
    };
  } catch (error) {
    payment.refunds.push({
      gatewayRefundId: null,
      amount: remainingPaise,
      status: "failed",
      reason,
      speed: "",
      initiatedBy: initiatedByAdminId,
      createdAt: new Date(),
      processedAt: null,
    });
    payment.refundFailureReason = error?.message || "Refund could not be initiated";
    payment.refundFailedAt = new Date();
    await payment.save().catch((saveErr) => {
      logger.error("porter_refund_failure_not_recorded", {
        paymentId: String(payment._id),
        message: saveErr?.message,
      });
    });

    logger.error("porter_refund_failed", {
      paymentId: String(payment._id),
      bookingKind: kind,
      bookingId: String(bookingId),
      message: error?.message,
    });

    return {
      attempted: true,
      ok: false,
      error: payment.refundFailureReason,
      amountPaise: remainingPaise,
      amountRupees: Number((remainingPaise / 100).toFixed(2)),
    };
  }
}

/* ==========================================================================
   Verifying — the fast path
   ========================================================================== */

/**
 * Verify the signed receipt checkout handed back to the browser.
 *
 * Two separate checks, and both matter. The signature proves the receipt came
 * from the gateway and belongs to this order — without it, anyone who can
 * call this endpoint gets a free delivery. Reading the status back proves the
 * money was CAPTURED — without that, an authorised-but-uncaptured payment
 * (or one the customer cancelled at the bank's page after the receipt was
 * issued) would dispatch a rider against money that never arrived.
 */
export async function verifyBookingReceipt({
  kind,
  bookingId,
  customerId,
  gatewayOrderId,
  gatewayPaymentId,
  signature,
  correlationId = null,
  onPaid = null,
}) {
  const payment = await PorterPayment.findOne({
    bookingKind: kind,
    bookingId,
    ...(gatewayOrderId ? { gatewayOrderId } : {}),
  }).sort({ createdAt: -1 });

  if (!payment) {
    const err = new Error("No payment attempt found for this booking");
    err.statusCode = 404;
    throw err;
  }

  if (customerId && String(payment.customerId) !== String(customerId)) {
    const err = new Error("This payment belongs to another customer");
    err.statusCode = 403;
    throw err;
  }

  // Replaying a verification must be a no-op, not a second broadcast.
  if (payment.isPaid()) {
    return { payment, status: payment.status, duplicate: true };
  }

  const provider = getActivePaymentProvider();
  const ok = provider.verifyCheckoutSignature({
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId,
    signature,
  });

  if (!ok) {
    /**
     * Deliberately leaves the attempt where it is.
     *
     * A signature that does not verify means "this receipt cannot be
     * trusted", not "the customer's payment failed". Writing FAILED here
     * would let a mangled or re-posted receipt from a customer who is still
     * mid-checkout brick their own booking, and the real payment could then
     * never be applied to it.
     */
    logger.warn("porter_payment_receipt_invalid", {
      paymentId: String(payment._id),
      referenceId: payment.referenceId,
      correlationId,
    });
    const err = new Error("This payment could not be verified");
    err.statusCode = 400;
    err.code = "INVALID_SIGNATURE";
    throw err;
  }

  payment.gatewaySignature = signature;
  payment.correlationId = correlationId || payment.correlationId;

  return reconcileFromGateway(payment, {
    source: PORTER_PAYMENT_SOURCE.CLIENT_VERIFY,
    onPaid,
  });
}

/**
 * Read the authoritative status back from the gateway and apply it.
 *
 * Shared by the client-verify path, the status-poll endpoint and the
 * reconciliation sweep, so all three agree by construction rather than by
 * three people remembering to keep them in step.
 */
export async function reconcileFromGateway(
  payment,
  { source = PORTER_PAYMENT_SOURCE.RECONCILIATION, onPaid = null } = {},
) {
  const provider = getActivePaymentProvider();

  const statusResp = await provider.getPaymentStatus({
    gatewayOrderId: payment.gatewayOrderId,
    merchantOrderId: payment.merchantReference,
  });

  const nextStatus = provider.mapStatusToInternal(statusResp.state);
  const entity =
    (statusResp.gatewayResponse?.payments || []).find(
      (p) => p.id === statusResp.transactionId,
    ) || null;

  absorbGatewayEntity(payment, entity);
  if (statusResp.transactionId) payment.gatewayPaymentId = statusResp.transactionId;
  payment.rawGatewayResponse = {
    ...(payment.rawGatewayResponse || {}),
    status: statusResp.gatewayResponse,
  };

  const changed = applyPorterStatus(payment, {
    nextStatus,
    source,
    reason: `${provider.providerName} reports ${statusResp.state}`,
    gatewayState: statusResp.state,
  });

  await payment.save();

  const booking = changed ? await applyBookingSideEffects(payment, { onPaid }) : null;

  return { payment, status: payment.status, changed, booking, duplicate: !changed };
}

/* ==========================================================================
   Webhooks — the reliable path
   ========================================================================== */

/**
 * Is this webhook one of ours?
 *
 * The shared route decodes the event once and offers it first to the
 * marketplace payment ledger and then here, so this has to be able to say
 * "not mine" cheaply and without side effects.
 */
export async function findPorterPaymentForWebhook(decoded) {
  const lookup = [];
  if (decoded.gatewayOrderId) lookup.push({ gatewayOrderId: decoded.gatewayOrderId });
  if (decoded.merchantOrderId) {
    lookup.push({ merchantReference: decoded.merchantOrderId });
    lookup.push({ gatewayOrderId: decoded.merchantOrderId });
  }
  if (decoded.transactionId) lookup.push({ gatewayPaymentId: decoded.transactionId });

  if (!lookup.length) return null;
  return PorterPayment.findOne({ $or: lookup });
}

/**
 * Apply a decoded gateway event.
 *
 * Idempotent twice over: the caller has already claimed the event id against
 * a unique index, and this records the id on the payment as well. The second
 * check is not redundant — the first collapses redeliveries of one event,
 * this one survives a redelivery that arrives while the first is still
 * in flight.
 */
export async function applyPorterWebhook(decoded, { onPaid = null } = {}) {
  const payment = await findPorterPaymentForWebhook(decoded);
  if (!payment) return { matched: false };

  if (decoded.eventId && payment.appliedEventIds.includes(decoded.eventId)) {
    return { matched: true, duplicate: true, payment };
  }

  const provider = getActivePaymentProvider();
  const entity = decoded.raw?.payload?.payment?.entity || null;
  const refundEntity = decoded.raw?.payload?.refund?.entity || null;

  absorbGatewayEntity(payment, entity);
  if (decoded.transactionId) payment.gatewayPaymentId = decoded.transactionId;

  let nextStatus = provider.mapStatusToInternal(decoded.state);

  /**
   * Refund events do not carry a payment status that maps to anything useful
   * — the payment entity is still `captured`. Whether this is a full or a
   * partial refund is the difference between the customer being made whole
   * and being partly refunded, and only the amounts can tell us which.
   */
  if (refundEntity || String(decoded.eventType || "").startsWith("refund.")) {
    const refundedSoFar =
      Number(entity?.amount_refunded) ||
      Number(payment.refundedAmount) + Number(refundEntity?.amount || 0);
    payment.refundedAmount = Math.min(payment.amount, refundedSoFar);

    if (refundEntity?.id && !payment.refunds.some((r) => r.gatewayRefundId === refundEntity.id)) {
      payment.refunds.push({
        gatewayRefundId: refundEntity.id,
        amount: Number(refundEntity.amount) || 0,
        status: refundEntity.status || "",
        speed: refundEntity.speed_processed || refundEntity.speed_requested || "",
        reason: refundEntity.notes?.reason || "",
        processedAt: new Date(),
      });
    }

    nextStatus =
      payment.refundedAmount >= payment.amount
        ? PORTER_PAYMENT_STATUS.REFUNDED
        : PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED;
  }

  payment.rawGatewayResponse = {
    ...(payment.rawGatewayResponse || {}),
    lastWebhook: decoded.raw,
  };
  if (decoded.eventId) {
    payment.appliedEventIds.push(decoded.eventId);
    // Bounded: a busy payment can see a dozen events, not a thousand, and an
    // unbounded array on a hot document is a slow leak.
    if (payment.appliedEventIds.length > 50) {
      payment.appliedEventIds = payment.appliedEventIds.slice(-50);
    }
  }

  const changed = applyPorterStatus(payment, {
    nextStatus,
    source: PORTER_PAYMENT_SOURCE.WEBHOOK,
    reason: `${provider.providerName} webhook: ${decoded.eventType}`,
    gatewayState: decoded.state,
    gatewayEventId: decoded.eventId,
  });

  await payment.save();

  let booking = null;
  if (changed) {
    if (payment.purpose === PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT) {
      const { applyRiderDepositSideEffects } = await import("./riderDepositService.js");
      await applyRiderDepositSideEffects(payment);
    } else {
      booking = await applyBookingSideEffects(payment, { onPaid });
    }
  }

  logger.info("porter_payment_webhook_applied", {
    paymentId: String(payment._id),
    eventType: decoded.eventType,
    status: payment.status,
    changed,
  });

  return { matched: true, duplicate: !changed, payment, booking, status: payment.status };
}

/* ==========================================================================
   Reads
   ========================================================================== */

/** Every attempt against a booking, newest first. The payment history strip. */
export async function getBookingPaymentHistory(kind, bookingId) {
  return PorterPayment.find({ bookingKind: kind, bookingId })
    .select("-gatewaySignature -rawGatewayResponse -appliedEventIds")
    .sort({ createdAt: -1 })
    .lean();
}

/** The attempt that actually paid for a booking, if any. */
export async function getCapturedPaymentForBooking(kind, bookingId) {
  return PorterPayment.findOne({
    bookingKind: kind,
    bookingId,
    status: {
      $in: [PORTER_PAYMENT_STATUS.CAPTURED, PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED],
    },
  })
    .select("-gatewaySignature -rawGatewayResponse -appliedEventIds")
    .sort({ capturedAt: -1 })
    .lean();
}

/**
 * Attempts stuck in flight past a grace period.
 *
 * Anything still PENDING long after checkout closed is either abandoned or a
 * payment whose webhook never arrived, and the second case is money the
 * platform holds against a booking that shows as unpaid. The sweep exists to
 * find those.
 */
export async function findStalePorterPayments({ olderThanMinutes = 15, limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanMinutes) * 60_000);
  return PorterPayment.find({
    status: { $in: PORTER_OPEN_STATUSES },
    gatewayOrderId: { $ne: null },
    createdAt: { $lte: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(limit);
}

export { PORTER_BOOKING_KIND, PORTER_PAYMENT_STATUS };
