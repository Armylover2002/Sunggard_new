import mongoose from "mongoose";

import PorterPayment from "../../models/porterPayment.js";
import CashDeposit from "../../models/cashDeposit.js";
import Delivery from "../../models/delivery.js";
import Notification from "../../models/notification.js";
import {
  PORTER_PAYER_TYPE,
  PORTER_PAYMENT_PURPOSE,
  PORTER_PAYMENT_SOURCE,
  PORTER_PAYMENT_STATUS,
  PORTER_OPEN_STATUSES,
} from "../../constants/porterPayment.js";
import { getActivePaymentProvider } from "../payment/providerRegistry.js";
import { getRiderCodSummary } from "../riderCashService.js";
import { applyPorterStatus, absorbGatewayEntity } from "./porterPaymentService.js";
import { emitToDelivery, emitToAdmins } from "../orderSocketEmitter.js";
import logger from "../logger.js";

/**
 * A rider returning collected COD cash to the platform, online.
 *
 * What this replaces: the admin published a UPI ID, a QR image and a bank
 * account; the rider transferred to it out of band and uploaded a screenshot;
 * an admin looked at the screenshot and clicked approve. Three problems with
 * that, in order of seriousness:
 *
 *   1. A screenshot is not a payment. It proves a rider had an image on their
 *      phone. Nothing in the system had any independent knowledge that money
 *      had moved, so "approval" was an admin's guess.
 *   2. Every deposit was a manual reconciliation against a bank statement,
 *      because the transfer landed with no reference tying it to a rider or
 *      to specific bookings.
 *   3. The destination had to be configured, kept current, and shown to
 *      riders — a whole surface of admin UI existing only because the money
 *      was leaving the system.
 *
 * Now the rider taps Deposit, the gateway opens for the FULL amount they are
 * holding, and the platform receives the money directly into its own account.
 * The admin still approves — that step is what moves the covered bookings to
 * REMITTED_TO_ADMIN — but they are now approving against a captured gateway
 * payment rather than a picture.
 *
 * Partial deposits are refused on purpose. The rule is that a rider deposits
 * what they hold; letting them pay ₹200 of ₹4,800 leaves the cash limit
 * permanently near its ceiling and turns the block into a nuisance rather
 * than a control.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);

const toOid = (id) =>
  mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;

/**
 * What the rider owes, and whether they can start a deposit right now.
 *
 * The amount is taken from the bookings the rider actually holds, never from
 * the client — a deposit request that named its own amount would let a rider
 * clear ₹5,000 of jobs by paying ₹1.
 */
export async function getRiderDepositQuote(riderId) {
  const oid = toOid(riderId);
  if (!oid) {
    const err = new Error("Unknown rider");
    err.statusCode = 400;
    throw err;
  }

  const [summary, openPayment] = await Promise.all([
    getRiderCodSummary(oid),
    PorterPayment.findOne({
      riderId: oid,
      purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
      status: { $in: PORTER_OPEN_STATUSES },
    })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  return {
    /** Everything not already claimed by a deposit awaiting review. */
    depositableAmount: summary.depositableAmount,
    items: summary.items,
    awaitingReviewAmount: summary.awaitingReviewAmount,
    pendingDepositCount: summary.pendingDepositCount,
    totalHeld: summary.totalHeld,
    canDeposit: summary.depositableAmount > 0,
    /** A checkout the rider abandoned; tapping Deposit resumes this one. */
    openPayment: openPayment
      ? {
          id: String(openPayment._id),
          amount: openPayment.amount,
          gatewayOrderId: openPayment.gatewayOrderId,
          createdAt: openPayment.createdAt,
        }
      : null,
  };
}

/**
 * Open a gateway order for the rider's full held balance.
 *
 * Re-uses a live attempt of the same amount for exactly the reason booking
 * payments do — two open orders is how somebody pays twice. If the amount has
 * moved (the rider collected another COD job between opening the sheet and
 * returning to it) the old order is cancelled and a new one opened, because
 * paying the stale one would leave a remainder that unblocks nothing.
 */
export async function openRiderDepositPayment({ riderId, correlationId = null }) {
  const oid = toOid(riderId);
  const quote = await getRiderDepositQuote(oid);

  if (!(quote.depositableAmount > 0)) {
    const err = new Error(
      quote.awaitingReviewAmount > 0
        ? "Your deposit is already with the admin for approval."
        : "You have no collected cash to deposit right now.",
    );
    err.statusCode = 400;
    throw err;
  }

  const provider = getActivePaymentProvider();
  if (!provider.isConfigured()) {
    const err = new Error("Online deposit is unavailable right now. Contact the admin.");
    err.statusCode = 503;
    throw err;
  }

  const amountPaise = toPaise(quote.depositableAmount);

  const open = await PorterPayment.findOne({
    riderId: oid,
    purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
    status: { $in: PORTER_OPEN_STATUSES },
  }).sort({ createdAt: -1 });

  if (open?.gatewayOrderId && open.amount === amountPaise) {
    /**
     * A reused order that Razorpay itself no longer recognises (expired, or
     * created against a key that has since changed) fails checkout every
     * time with no way for the rider to recover — nothing else ever bumps
     * the amount to force a fresh order. Confirming it's still live before
     * handing it back turns that dead end into a retry.
     */
    try {
      await provider.getPaymentStatus({
        gatewayOrderId: open.gatewayOrderId,
        merchantOrderId: open.merchantReference,
      });
      return {
        payment: open,
        checkout: {
          orderId: open.gatewayOrderId,
          keyId: process.env.RAZORPAY_KEY_ID,
          amount: open.amount,
          currency: open.currency,
        },
        amount: quote.depositableAmount,
        items: quote.items,
        reused: true,
      };
    } catch (error) {
      logger.warn("porter_rider_deposit_stale_order", {
        paymentId: String(open._id),
        gatewayOrderId: open.gatewayOrderId,
        reason: error?.message || "unknown",
      });
    }
  }

  if (open) {
    applyPorterStatus(open, {
      nextStatus: PORTER_PAYMENT_STATUS.CANCELLED,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: "Superseded — the rider's held balance changed, or the prior order was no longer usable",
    });
    await open.save();
  }

  const rider = await Delivery.findById(oid).select("name phone").lean();
  const attemptCount =
    (await PorterPayment.countDocuments({
      riderId: oid,
      purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
    })) + 1;
  const merchantReference = `PTR-DEP-${String(oid).slice(-12)}-A${attemptCount}`.slice(0, 40);

  const payment = await PorterPayment.create({
    purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
    payerType: PORTER_PAYER_TYPE.RIDER,
    riderId: oid,
    referenceId: merchantReference,
    gatewayName: provider.providerName,
    merchantReference,
    amount: amountPaise,
    currency: "INR",
    status: PORTER_PAYMENT_STATUS.CREATED,
    attemptCount,
    correlationId,
    /**
     * Which bookings this deposit is meant to clear, snapshotted at open
     * time. Without it, an approval maps to a floating balance and the admin
     * can never answer "which jobs did this cover".
     */
    bookingSnapshot: {
      riderName: rider?.name || "",
      riderPhone: rider?.phone || "",
      items: quote.items,
      totalHeld: quote.totalHeld,
    },
    notes: {
      purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
      riderId: String(oid),
    },
  });

  try {
    const init = await provider.initiatePayment({
      merchantOrderId: merchantReference,
      amountPaise,
      currency: "INR",
      notes: {
        purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
        riderId: String(oid),
        riderName: rider?.name || "",
        jobCount: String(quote.items.length),
      },
    });

    payment.gatewayOrderId = init.gatewayOrderId;
    payment.rawGatewayResponse = { order: init.gatewayResponse };
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.PENDING,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: "Rider cash deposit checkout opened",
    });
    await payment.save();

    return {
      payment,
      checkout: init.checkout,
      amount: quote.depositableAmount,
      items: quote.items,
      reused: false,
    };
  } catch (error) {
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.FAILED,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: `Could not open the deposit order: ${error?.message || "unknown"}`,
    });
    payment.failureReason = error?.message || "Could not start the deposit";
    await payment.save().catch(() => {});
    throw error;
  }
}

/**
 * Turn a captured deposit payment into a CashDeposit awaiting admin review.
 *
 * Called from both the verify path and the webhook path, and idempotent
 * across them: `cashDepositId` on the payment is the guard, so a webhook
 * landing a moment after the rider's own verify does not raise a second
 * deposit for the same money.
 *
 * The items are resolved AGAIN here rather than trusted from the snapshot.
 * Between opening the sheet and the money landing, one of those bookings may
 * have been settled another way — claiming it a second time would double-count
 * it against the rider's balance.
 */
export async function applyRiderDepositSideEffects(payment) {
  if (payment.purpose !== PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT) return null;
  if (!payment.isPaid()) return null;
  if (payment.cashDepositId) {
    return CashDeposit.findById(payment.cashDepositId);
  }

  const summary = await getRiderCodSummary(payment.riderId);
  const rupees = round2(payment.amount / 100);

  /**
   * If everything was settled elsewhere in the meantime the rider has paid
   * money that covers nothing. That is a real situation — a race, or an admin
   * clearing the jobs by hand — and it must not be swallowed: the deposit is
   * still recorded, with no items, so an admin sees an unattributed credit
   * and can refund or reassign it rather than the money vanishing.
   */
  const items = summary.items;

  const deposit = await CashDeposit.create({
    riderId: payment.riderId,
    amount: rupees,
    method: "ONLINE",
    reference: payment.gatewayPaymentId || payment.gatewayOrderId || "",
    proofImageUrl: "",
    note: items.length
      ? `Paid online via ${payment.instrument?.method || "gateway"}`
      : "Paid online — no open bookings matched at capture time",
    items: items.map((item) => ({
      kind: item.kind,
      refId: toOid(item.refId),
      amount: item.amount,
      label: item.label,
    })),
    porterPaymentId: payment._id,
    status: "PENDING",
  });

  payment.cashDepositId = deposit._id;
  await payment.save();

  await Notification.create({
    recipient: payment.riderId,
    recipientModel: "Delivery",
    title: "Deposit received",
    message: `Your ₹${rupees} online deposit has reached the admin and is waiting for approval. New jobs resume once it is approved.`,
    type: "payment",
    data: { depositId: String(deposit._id) },
  }).catch(() => {
    /* a notification failure must not undo a captured deposit */
  });

  emitToDelivery(String(payment.riderId), "porter:cash:deposit:created", {
    depositId: String(deposit._id),
    amount: rupees,
    status: "PENDING",
  });
  emitToAdmins("porter:cash:deposit:new", {
    depositId: String(deposit._id),
    riderId: String(payment.riderId),
    amount: rupees,
    method: "ONLINE",
  });

  logger.info("porter_rider_deposit_captured", {
    paymentId: String(payment._id),
    depositId: String(deposit._id),
    riderId: String(payment.riderId),
    amount: rupees,
    jobCount: items.length,
  });

  return deposit;
}

/**
 * Verify the rider's checkout receipt, then read the real status back.
 *
 * Same two-step as a booking payment, for the same reason: the signature
 * proves the receipt is genuine, the status read proves the money was
 * captured. A rider must not be un-blocked on an authorised-but-uncaptured
 * payment.
 */
export async function verifyRiderDepositReceipt({
  riderId,
  gatewayOrderId,
  gatewayPaymentId,
  signature,
  correlationId = null,
}) {
  const oid = toOid(riderId);

  const payment = await PorterPayment.findOne({
    riderId: oid,
    purpose: PORTER_PAYMENT_PURPOSE.RIDER_CASH_DEPOSIT,
    gatewayOrderId,
  });

  if (!payment) {
    const err = new Error("No deposit attempt found");
    err.statusCode = 404;
    throw err;
  }

  if (payment.isPaid()) {
    const deposit = await applyRiderDepositSideEffects(payment);
    return { payment, deposit, duplicate: true };
  }

  const provider = getActivePaymentProvider();
  const ok = provider.verifyCheckoutSignature({
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId,
    signature,
  });

  if (!ok) {
    logger.warn("porter_deposit_receipt_invalid", {
      paymentId: String(payment._id),
      riderId: String(oid),
    });
    const err = new Error("This deposit could not be verified");
    err.statusCode = 400;
    throw err;
  }

  payment.gatewaySignature = signature;
  payment.correlationId = correlationId || payment.correlationId;

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

  const changed = applyPorterStatus(payment, {
    nextStatus,
    source: PORTER_PAYMENT_SOURCE.CLIENT_VERIFY,
    reason: `Gateway reports ${statusResp.state}`,
    gatewayState: statusResp.state,
  });
  await payment.save();

  if (!payment.isPaid()) {
    const err = new Error(
      payment.status === PORTER_PAYMENT_STATUS.FAILED
        ? payment.errorDescription || "The deposit payment failed. Try again."
        : "The deposit has not been confirmed by the bank yet. Give it a moment.",
    );
    err.statusCode = 402;
    throw err;
  }

  const deposit = await applyRiderDepositSideEffects(payment);
  return { payment, deposit, duplicate: !changed };
}
