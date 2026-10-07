import Parcel from "../../models/parcel.js";
import PorterPayment from "../../models/porterPayment.js";
import {
  PORTER_BOOKING_KIND,
  PORTER_PAYMENT_PURPOSE,
  PORTER_PAYMENT_STATUS,
} from "../../constants/porterPayment.js";

/**
 * What happened to the money on a cancelled online booking, for the admin.
 *
 * The refund itself is issued by porterPaymentService.refundBookingPayment and
 * recorded on the PorterPayment row (refunds[], refundedAmount, refund
 * failure fields). This only READS that record and puts it next to the
 * booking, so an admin no longer has to open the payment gateway to answer
 * "did this customer get their money back". Nothing here writes anything.
 *
 * COD bookings never go through the gateway, so they have no refund.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const toRupees = (paise) => round2((Number(paise) || 0) / 100);

export const REFUND_STATE = {
  /** Money has been sent back (see `gatewayStatus` for bank progress). */
  REFUNDED: "REFUNDED",
  PARTIAL: "PARTIAL",
  /** Booking is cancelled and paid, but no refund has gone out yet. */
  PENDING: "PENDING",
  /** A refund was attempted and the gateway refused it. */
  FAILED: "FAILED",
};

/** Which of a booking's payment attempts tells the refund story. */
const paymentRank = (payment) => {
  if ((payment.refundedAmount || 0) > 0) return 3;
  if (payment.refundFailedAt) return 2;
  if (payment.status === PORTER_PAYMENT_STATUS.CAPTURED) return 1;
  return 0;
};

export function summarizeRefund(payment, parcel) {
  if (!payment) return null;

  const paidAmount = toRupees(payment.amount);
  const refundedPaise = payment.refundedAmount || 0;
  const refunds = payment.refunds || [];

  if (refundedPaise > 0) {
    const last = [...refunds].reverse().find((r) => r.status !== "failed") || null;
    return {
      state: refundedPaise >= (payment.amount || 0) ? REFUND_STATE.REFUNDED : REFUND_STATE.PARTIAL,
      amount: toRupees(refundedPaise),
      paidAmount,
      // "processed" = reached the customer's bank; anything else is still
      // on its way.
      gatewayStatus: last?.status || "",
      gatewayRefundId: last?.gatewayRefundId || "",
      at: payment.refundedAt || last?.createdAt || null,
      method: payment.instrument?.method || "",
    };
  }

  if (payment.refundFailedAt) {
    return {
      state: REFUND_STATE.FAILED,
      amount: round2(paidAmount - toRupees(refundedPaise)),
      paidAmount,
      reason: payment.refundFailureReason || "Refund could not be initiated",
      at: payment.refundFailedAt,
      method: payment.instrument?.method || "",
    };
  }

  if (parcel?.status === "CANCELLED" && payment.status === PORTER_PAYMENT_STATUS.CAPTURED) {
    return {
      state: REFUND_STATE.PENDING,
      amount: paidAmount,
      paidAmount,
      method: payment.instrument?.method || "",
    };
  }

  return null;
}

/**
 * A wallet booking is refunded straight back into the customer's wallet, so
 * its story lives on the parcel (walletPayment), not on a gateway payment.
 */
export function summarizeWalletRefund(parcel) {
  const wallet = parcel?.walletPayment || {};
  const amount = round2(wallet.amount || parcel?.payableFare || parcel?.fare);
  if (wallet.refundedAt) {
    return {
      state: REFUND_STATE.REFUNDED,
      amount,
      paidAmount: amount,
      gatewayStatus: "processed",
      via: "WALLET",
      at: wallet.refundedAt,
      method: "wallet",
    };
  }
  if (parcel?.status === "CANCELLED" && wallet.paidAt) {
    return {
      state: REFUND_STATE.PENDING,
      amount,
      paidAmount: amount,
      via: "WALLET",
      method: "wallet",
    };
  }
  return null;
}

/** parcelId (string) -> refund summary, for online and wallet bookings. */
export async function getRefundSummaryByParcel(parcels = []) {
  const byId = new Map();
  const isWallet = (p) => String(p?.paymentMethod).toUpperCase() === "WALLET";

  for (const parcel of parcels) {
    if (parcel && isWallet(parcel)) {
      const summary = summarizeWalletRefund(parcel);
      if (summary) byId.set(String(parcel._id), summary);
    }
  }

  const online = parcels.filter(
    (p) => p && String(p.paymentMethod).toUpperCase() !== "COD" && !isWallet(p),
  );
  if (!online.length) return byId;

  const payments = await PorterPayment.find({
    bookingKind: PORTER_BOOKING_KIND.PARCEL,
    purpose: PORTER_PAYMENT_PURPOSE.BOOKING,
    bookingId: { $in: online.map((p) => p._id) },
  })
    .select(
      "bookingId amount status refundedAmount refunds refundedAt refundFailedAt refundFailureReason instrument",
    )
    .lean();

  const best = new Map();
  for (const payment of payments) {
    const key = String(payment.bookingId);
    const current = best.get(key);
    if (!current || paymentRank(payment) > paymentRank(current)) best.set(key, payment);
  }

  for (const parcel of online) {
    const summary = summarizeRefund(best.get(String(parcel._id)), parcel);
    if (summary) byId.set(String(parcel._id), summary);
  }
  return byId;
}

/**
 * Totals across cancelled online bookings matching `parcelFilter`.
 * `pending` is paid-and-cancelled with no refund out yet.
 */
export async function getRefundTotals(parcelFilter = {}) {
  const cancelledOnline = await Parcel.find({
    $and: [parcelFilter, { status: "CANCELLED", paymentMethod: { $ne: "COD" } }],
  })
    .select("_id status paymentMethod walletPayment payableFare fare")
    .lean();

  const summaries = await getRefundSummaryByParcel(cancelledOnline);
  const totals = {
    refundedCount: 0,
    refundedAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
    failedCount: 0,
    failedAmount: 0,
  };
  for (const summary of summaries.values()) {
    if (summary.state === REFUND_STATE.REFUNDED || summary.state === REFUND_STATE.PARTIAL) {
      totals.refundedCount += 1;
      totals.refundedAmount += summary.amount;
    } else if (summary.state === REFUND_STATE.PENDING) {
      totals.pendingCount += 1;
      totals.pendingAmount += summary.amount;
    } else if (summary.state === REFUND_STATE.FAILED) {
      totals.failedCount += 1;
      totals.failedAmount += summary.amount;
    }
  }
  totals.refundedAmount = round2(totals.refundedAmount);
  totals.pendingAmount = round2(totals.pendingAmount);
  totals.failedAmount = round2(totals.failedAmount);
  return totals;
}
