import mongoose from "mongoose";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import Parcel from "../models/parcel.js";
import {
  getRiderCodSummary,
  createCashDeposit,
  reviewCashDeposit,
  listCashDeposits,
  getFleetCashHoldings,
  getCashPayoutDestination,
  updateCashPayoutDestination,
} from "../services/riderCashService.js";
import {
  createCodQr,
  fetchCodQrStatus,
  closeCodQr,
  isCodQrAvailable,
} from "../services/codQrService.js";
import {
  getRiderCashStatus,
  getPorterCashSettings,
  updatePorterCashSettings,
  setRiderCashLimit,
  getFleetCashOverview,
} from "../services/porter/riderCashLimitService.js";
import {
  getRiderDepositQuote,
  openRiderDepositPayment,
  verifyRiderDepositReceipt,
} from "../services/porter/riderDepositService.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";

/**
 * Statuses in which the rider has NOT yet physically collected the parcel —
 * cash only enters the "Cash Collection" ledger at pickup (see
 * riderUpdateStatus → recordCodCollection in parcelController.js). A QR can
 * only be created/paid while still in one of these: creating one after
 * pickup would mean the rider is already holding the cash while the customer
 * also pays online, and letting an already-created QR complete after pickup
 * would leave that ledger entry unreversed — two records of the same money.
 */
const PRE_PICKUP_STATUSES = {
  parcel: new Set(["ACCEPTED", "RIDER_ASSIGNED", "PICKUP_REACHED"]),
};

/* ==========================================================================
   Rider — COD cash they are holding, and depositing it back
   ========================================================================== */

export const riderGetCashSummary = async (req, res) => {
  try {
    const summary = await getRiderCodSummary(req.user.id);
    return handleResponse(res, 200, "Cash summary", summary);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

const DEPOSIT_METHODS = new Set(["UPI", "BANK_TRANSFER", "CASH", "OTHER"]);

export const riderCreateCashDeposit = async (req, res) => {
  try {
    const { method, reference, proofImageUrl, note, items } = req.body || {};

    if (!DEPOSIT_METHODS.has(String(method || "").toUpperCase())) {
      return handleResponse(res, 400, "Choose how you deposited the cash");
    }

    const deposit = await createCashDeposit({
      riderId: req.user.id,
      method: String(method).toUpperCase(),
      reference,
      proofImageUrl,
      note,
      selection: Array.isArray(items) ? items : null,
    });

    return handleResponse(
      res,
      201,
      "Deposit submitted — admin will verify it shortly",
      deposit,
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const riderListCashDeposits = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 20, maxLimit: 50 });
    const data = await listCashDeposits({
      status: req.query.status || "all",
      riderId: req.user.id,
      page,
      limit,
      skip,
    });
    return handleResponse(res, 200, "Deposit history", data);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Rider — turning a COD booking into an online payment at the doorstep
   ========================================================================== */

/** Loads the booking either flow, with the fields this controller needs. */
async function loadBooking(kind, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  if (kind === "parcel") return Parcel.findById(id);
  return null;
}

const codStateFor = (kind, booking) => booking.codSettlement;

/** The rider must own the job before they can collect against it. */
function assertRiderOwnsBooking(booking, riderId) {
  if (String(booking.deliveryPartnerId || "") !== String(riderId)) {
    const err = new Error("This booking is not assigned to you");
    err.statusCode = 403;
    throw err;
  }
}

export const riderCreateCodQr = async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!isCodQrAvailable()) {
      return handleResponse(res, 503, "Online payment is unavailable — collect cash instead");
    }

    const booking = await loadBooking(kind, id);
    if (!booking) return handleResponse(res, 404, "Booking not found");
    assertRiderOwnsBooking(booking, req.user.id);

    if (String(booking.paymentMethod).toUpperCase() !== "COD") {
      return handleResponse(res, 400, "This booking is not cash on delivery");
    }
    if (booking.paymentStatus === "PAID") {
      return handleResponse(res, 400, "This booking is already paid");
    }
    if (!PRE_PICKUP_STATUSES[kind]?.has(booking.status)) {
      return handleResponse(
        res,
        400,
        "This can only be offered before pickup — the cash is already collected",
      );
    }

    // Reuse a QR that is still live rather than minting one per tap — a
    // second QR for the same booking would be a second way to charge twice.
    const existing = booking.codOnlineQr || {};
    if (existing.qrId && !existing.paidAt) {
      return handleResponse(res, 200, "Scan to pay", {
        qrId: existing.qrId,
        imageUrl: existing.imageUrl,
        amount: existing.amount,
      });
    }

    const codState = codStateFor(kind, booking) || {};
    const amount =
      Number(codState.collectAmount) || Number(codState.amount) || Number(booking.fare);

    const qr = await createCodQr({
      amount,
      label: `Delivery ${booking.referenceId || String(booking._id).slice(-6).toUpperCase()}`,
      notes: {
        kind,
        bookingId: String(booking._id),
        riderId: String(req.user.id),
        purpose: "cod_switch_to_online",
      },
    });

    booking.codOnlineQr = {
      qrId: qr.qrId,
      imageUrl: qr.imageUrl,
      amount: qr.amount,
      createdAt: new Date(),
      paidAt: null,
      paymentId: null,
    };
    await booking.save();

    return handleResponse(res, 201, "Scan to pay", {
      qrId: qr.qrId,
      imageUrl: qr.imageUrl,
      amount: qr.amount,
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const riderCheckCodQr = async (req, res) => {
  try {
    const { kind, id } = req.params;
    const booking = await loadBooking(kind, id);
    if (!booking) return handleResponse(res, 404, "Booking not found");
    assertRiderOwnsBooking(booking, req.user.id);

    // Already converted on an earlier poll — answer from the document rather
    // than calling Razorpay again.
    if (booking.paymentStatus === "PAID") {
      return handleResponse(res, 200, "Payment received", {
        paid: true,
        paymentMethod: booking.paymentMethod,
      });
    }

    const qrId = booking.codOnlineQr?.qrId;
    if (!qrId) {
      return handleResponse(res, 400, "No payment QR has been created for this booking");
    }

    // Rider moved on (picked up, cash already recorded in hand) while this QR
    // sat open — closing it here stops a late scan from converting the
    // booking on top of cash that's already in the "Cash Collection" ledger.
    if (!PRE_PICKUP_STATUSES[kind]?.has(booking.status)) {
      await closeCodQr(qrId);
      return handleResponse(
        res,
        400,
        "This payment window has closed — the parcel was already picked up for cash",
      );
    }

    const status = await fetchCodQrStatus(qrId, booking.codOnlineQr?.amount);
    if (!status.paid) {
      return handleResponse(res, 200, "Waiting for payment", { paid: false });
    }

    // Paid: the booking stops being COD entirely, so the rider carries no
    // cash for it and it counts as an online payment everywhere downstream.
    booking.paymentStatus = "PAID";
    booking.paymentMethod = "UPI";
    booking.codOnlineQr.paidAt = new Date();
    booking.codOnlineQr.paymentId = status.paymentId || null;

    booking.codSettlement = {
      ...(booking.codSettlement?.toObject?.() || booking.codSettlement || {}),
      collectAmount: 0,
      status: "NOT_APPLICABLE",
    };

    await booking.save();
    await closeCodQr(qrId);

    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE, {
      userId: booking.customerId,
      customerId: booking.customerId,
      parcelId: booking._id,
      status: "PAID_ONLINE",
      body: `Your ₹${booking.codOnlineQr.amount / 100} payment was received — no cash needed at drop.`,
      data: { title: "Payment received", parcelId: String(booking._id), status: "PAID_ONLINE" },
    });

    return handleResponse(res, 200, "Payment received", {
      paid: true,
      paymentMethod: "UPI",
      paymentId: status.paymentId || null,
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Admin — the deposit approval queue
   ========================================================================== */

export const adminListCashDeposits = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 100 });
    const data = await listCashDeposits({
      status: req.query.status || "PENDING",
      riderId: req.query.riderId || null,
      page,
      limit,
      skip,
    });
    return handleResponse(res, 200, "Cash deposits", data);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminReviewCashDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    const { approve, adminNote } = req.body || {};

    if (typeof approve !== "boolean") {
      return handleResponse(res, 400, "approve must be true or false");
    }

    const result = await reviewCashDeposit({
      depositId: id,
      adminId: req.user?.id,
      approve,
      adminNote,
    });

    if (!result) return handleResponse(res, 404, "Deposit not found");

    return handleResponse(
      res,
      200,
      approve ? "Deposit approved and cash cleared" : "Deposit rejected",
      result,
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminGetFleetCashHoldings = async (req, res) => {
  try {
    const data = await getFleetCashHoldings();
    return handleResponse(res, 200, "Cash held by riders", data);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Rider — the cash limit, and depositing online
   ========================================================================== */

/**
 * What the rider is holding, what their limit is, and whether they are
 * blocked.
 *
 * The rider app polls this alongside the job feed so the meter is always
 * live. Being surprised by the block — jobs silently stopping with no
 * explanation — is the failure this exists to prevent.
 */
export const riderGetCashStatus = async (req, res) => {
  try {
    const [status, quote] = await Promise.all([
      getRiderCashStatus(req.user.id),
      getRiderDepositQuote(req.user.id),
    ]);
    return handleResponse(res, 200, "Cash status", { ...status, deposit: quote });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/**
 * Open a gateway order for the rider's FULL held balance.
 *
 * The amount is never taken from the request — it is summed from the bookings
 * the rider actually holds. A client-supplied amount would let a rider clear
 * ₹5,000 of jobs by paying ₹1.
 */
export const riderStartOnlineDeposit = async (req, res) => {
  try {
    const result = await openRiderDepositPayment({
      riderId: req.user.id,
      correlationId: req.correlationId || null,
    });

    return handleResponse(res, 201, "Complete the payment to deposit", {
      // The shape the rider app's checkout launcher already reads.
      razorpay: {
        keyId: result.checkout.keyId,
        orderId: result.checkout.orderId,
        amount: result.checkout.amount,
        currency: result.checkout.currency,
      },
      amount: result.amount,
      items: result.items,
      paymentId: String(result.payment._id),
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/**
 * Confirm the deposit. No admin approval step for an online deposit — the
 * signature check plus the gateway status read above already prove the
 * money was captured, so the covered bookings are remitted and the rider's
 * cash-limit block is lifted in the same request.
 */
export const riderVerifyOnlineDeposit = async (req, res) => {
  try {
    const {
      razorpay_order_id: gatewayOrderId,
      razorpay_payment_id: gatewayPaymentId,
      razorpay_signature: signature,
    } = req.body || {};

    const { deposit, duplicate } = await verifyRiderDepositReceipt({
      riderId: req.user.id,
      gatewayOrderId,
      gatewayPaymentId,
      signature,
      correlationId: req.correlationId || null,
    });

    return handleResponse(
      res,
      duplicate ? 200 : 201,
      "Deposit verified and cleared",
      { deposit },
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Admin — cash limits
   ========================================================================== */

/**
 * The fleet, with each rider's limit, what they hold, and what is left.
 *
 * Replaces the old aggregation that summed the legacy Transaction ledger and
 * read `{ $ifNull: ["$limit", 5000] }` off a field that does not exist on the
 * Delivery model — so every rider showed a ₹5,000 limit that nothing could
 * change and nothing enforced.
 */
export const adminGetPorterCashOverview = async (req, res) => {
  try {
    const { page, limit } = getPagination(req, { defaultLimit: 25, maxLimit: 100 });
    const data = await getFleetCashOverview({
      search: req.query.search || "",
      page,
      limit,
    });
    return handleResponse(res, 200, "Rider cash overview", data);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminGetPorterCashSettings = async (req, res) => {
  try {
    const settings = await getPorterCashSettings();
    return handleResponse(res, 200, "Cash settings", settings);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminUpdatePorterCashSettings = async (req, res) => {
  try {
    const settings = await updatePorterCashSettings(req.body || {});
    return handleResponse(res, 200, "Cash settings updated", settings);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/**
 * Set or clear one rider's own limit.
 *
 * A null / empty `cashLimit` clears the override and puts them back on the
 * global limit — deliberately distinct from 0, which means this rider may
 * carry no cash at all.
 */
export const adminSetRiderCashLimit = async (req, res) => {
  try {
    const rider = await setRiderCashLimit(req.params.id, req.body?.cashLimit);
    const status = await getRiderCashStatus(req.params.id);
    return handleResponse(res, 200, "Cash limit updated", { rider, status });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Where to send the cash
   ========================================================================== */

/** Rider-facing, read-only: what admin has configured to deposit into. */
export const riderGetCashPayoutDestination = async (req, res) => {
  try {
    const destination = await getCashPayoutDestination();
    return handleResponse(res, 200, "Deposit destination", destination);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminGetCashPayoutDestination = async (req, res) => {
  try {
    const destination = await getCashPayoutDestination();
    return handleResponse(res, 200, "Deposit destination", destination);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminUpdateCashPayoutDestination = async (req, res) => {
  try {
    const destination = await updateCashPayoutDestination(req.body || {});
    return handleResponse(res, 200, "Deposit destination updated", destination);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};
