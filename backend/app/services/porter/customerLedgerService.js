import mongoose from "mongoose";
import User from "../../models/customer.js";
import Transaction from "../../models/transaction.js";
import logger from "../logger.js";

/**
 * Where a porter payment lands once it is real.
 *
 * Three places, each answering a different question:
 *
 *   PorterPayment       — "what did the gateway do?" Full lifecycle, kept by
 *                         services/porter/porterPaymentService.js.
 *   Transaction         — "what does the platform's ledger say?" The legacy
 *                         but still-read ledger the admin finance screens
 *                         aggregate over. Porter never wrote to it, which is
 *                         why porter revenue was invisible beside marketplace
 *                         revenue.
 *   User.transactions   — "what has THIS customer paid?" A capped,
 *                         denormalised strip on the customer document so a
 *                         support agent or the customer's own app can see the
 *                         money trail without a second query.
 *
 * All three are written from here so they cannot drift apart one caller at a
 * time.
 */

/**
 * How many rows the customer's inline strip keeps.
 *
 * An uncapped array on a user document grows until that user's profile stops
 * loading — a daily commuter would pass a thousand rows inside two years.
 * Fifty covers every "recent activity" surface in the apps; anything older is
 * a paginated query against the collections above, which is what those are
 * indexed for.
 */
export const CUSTOMER_TRANSACTION_CAP = 50;

const toOid = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
};

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Push one row onto the customer's inline strip.
 *
 * `$push` with `$position: 0` and `$slice` does the insert, the ordering and
 * the trim in a single atomic update — reading the array, unshifting it and
 * writing it back would lose a row whenever two payments landed at once,
 * which is exactly what happens when a webhook and a client verify arrive
 * together.
 */
export async function pushCustomerTransaction(customerId, entry) {
  const oid = toOid(customerId);
  if (!oid || !entry) return null;

  const row = {
    refId: toOid(entry.refId),
    refModel: entry.refModel || "PorterPayment",
    kind: entry.kind || "PAYMENT",
    source: entry.source || "",
    reference: String(entry.reference || ""),
    amount: round2(entry.amount),
    currency: entry.currency || "INR",
    status: String(entry.status || ""),
    method: String(entry.method || ""),
    gatewayPaymentId: String(entry.gatewayPaymentId || ""),
    gstAmount: round2(entry.gstAmount),
    note: String(entry.note || ""),
    at: entry.at || new Date(),
  };

  try {
    await User.updateOne(
      { _id: oid },
      {
        $push: {
          transactions: {
            $each: [row],
            $position: 0,
            $slice: CUSTOMER_TRANSACTION_CAP,
          },
        },
      },
    );
    return row;
  } catch (error) {
    // A ledger strip is a convenience. Failing to update it must never undo
    // a payment that the gateway has already taken money for.
    logger.warn("porter_customer_transaction_push_failed", {
      customerId: String(customerId),
      reference: row.reference,
      message: error?.message,
    });
    return null;
  }
}

/**
 * The platform ledger row for a porter payment.
 *
 * Upserted on a deterministic reference, so the client verify and the webhook
 * — which routinely both land for the same payment, in either order — produce
 * one row rather than two. Without that, every online porter booking would
 * be counted twice in revenue.
 */
export async function recordPorterLedgerEntry({
  customerId,
  reference,
  type = "Parcel Payment",
  amount,
  status = "Settled",
  meta = {},
}) {
  const oid = toOid(customerId);
  const value = round2(amount);
  if (!oid || !reference || !(Math.abs(value) > 0)) return null;

  try {
    return await Transaction.findOneAndUpdate(
      { reference: String(reference) },
      {
        $set: { amount: value, status, meta },
        $setOnInsert: {
          user: oid,
          userModel: "User",
          type,
          reference: String(reference),
          date: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    logger.warn("porter_ledger_entry_failed", {
      reference,
      message: error?.message,
    });
    return null;
  }
}

/**
 * Record a captured porter payment everywhere it belongs.
 *
 * `payment` is a PorterPayment document. Deliberately takes the whole
 * document rather than loose fields: the amount, the tax and the instrument
 * all have to agree with what the gateway actually reported, and passing
 * them separately is how they stop agreeing.
 */
export async function recordPorterPaymentCaptured(payment) {
  if (!payment?.customerId) return;

  const rupees = round2(payment.amount / 100);
  const reference = `PORTER-PAY-${String(payment._id)}`;

  await Promise.all([
    pushCustomerTransaction(payment.customerId, {
      refId: payment._id,
      refModel: "PorterPayment",
      kind: "PAYMENT",
      source: payment.bookingKind || "",
      reference: payment.referenceId || reference,
      amount: rupees,
      currency: payment.currency,
      status: payment.status,
      method: payment.instrument?.method || "",
      gatewayPaymentId: payment.gatewayPaymentId || "",
      gstAmount: payment.taxSnapshot?.gstAmount || 0,
      note: "Outstation parcel booking",
      at: payment.capturedAt || new Date(),
    }),
    recordPorterLedgerEntry({
      customerId: payment.customerId,
      reference,
      type: "Parcel Payment",
      amount: rupees,
      status: "Settled",
      meta: {
        source: "porter_payment",
        purpose: payment.purpose,
        bookingKind: payment.bookingKind,
        bookingId: String(payment.bookingId || ""),
        referenceId: payment.referenceId || "",
        gatewayOrderId: payment.gatewayOrderId || "",
        gatewayPaymentId: payment.gatewayPaymentId || "",
        gstAmount: payment.taxSnapshot?.gstAmount || 0,
        gstPercent: payment.taxSnapshot?.gstPercent || 0,
      },
    }),
  ]);
}

/**
 * Record COD cash the customer handed to a rider.
 *
 * There is no gateway here and no PorterPayment row — the money went from a
 * hand to a hand — but the customer's own history should still show that
 * they paid, and the ledger should still know the booking was settled.
 */
export async function recordPorterCodCollected({
  customerId,
  bookingKind,
  bookingId,
  referenceId,
  amount,
  gstAmount = 0,
}) {
  const rupees = round2(amount);
  if (!customerId || !(rupees > 0)) return;

  const reference = `PORTER-COD-PCL-${String(bookingId)}`;

  await Promise.all([
    pushCustomerTransaction(customerId, {
      refId: bookingId,
      refModel: "Transaction",
      kind: "COD",
      source: bookingKind,
      reference: referenceId || reference,
      amount: rupees,
      status: "PAID",
      method: "cash",
      gstAmount,
      note: "Paid in cash at pickup",
    }),
    recordPorterLedgerEntry({
      customerId,
      reference,
      type: "Parcel Payment",
      amount: rupees,
      status: "Settled",
      meta: {
        source: "porter_cod",
        bookingKind,
        bookingId: String(bookingId),
        referenceId: referenceId || "",
        gstAmount,
      },
    }),
  ]);
}

/**
 * Record money going back to the customer.
 *
 * The customer-facing amount is negative, because the strip's sign convention
 * is "positive is money out of the customer" — a refund is the opposite of a
 * payment and must read that way on their own screen.
 */
export async function recordPorterRefund(payment, refundAmountPaise, reason = "") {
  if (!payment?.customerId) return;

  const rupees = round2(refundAmountPaise / 100);
  if (!(rupees > 0)) return;

  const reference = `PORTER-RFD-${String(payment._id)}-${Math.round(refundAmountPaise)}`;

  await Promise.all([
    pushCustomerTransaction(payment.customerId, {
      refId: payment._id,
      refModel: "PorterPayment",
      kind: "REFUND",
      source: payment.bookingKind || "",
      reference: payment.referenceId || reference,
      amount: -rupees,
      status: payment.status,
      method: payment.instrument?.method || "",
      gatewayPaymentId: payment.gatewayPaymentId || "",
      note: reason || "Refund issued",
    }),
    recordPorterLedgerEntry({
      customerId: payment.customerId,
      reference,
      type: "Parcel Refund",
      amount: -rupees,
      status: "Settled",
      meta: {
        source: "porter_refund",
        bookingKind: payment.bookingKind,
        bookingId: String(payment.bookingId || ""),
        reason,
      },
    }),
  ]);
}

/**
 * A customer's own money trail, newest first.
 *
 * Reads the capped strip because it is one document and already ordered.
 * Callers wanting the complete history query `PorterPayment` directly — this
 * is the "recent activity" answer, and says so by never claiming a total.
 */
export async function getCustomerTransactionStrip(customerId, limit = CUSTOMER_TRANSACTION_CAP) {
  const oid = toOid(customerId);
  if (!oid) return [];

  const user = await User.findById(oid).select("+transactions").lean();
  return (user?.transactions || []).slice(0, Math.max(1, Number(limit) || 25));
}
