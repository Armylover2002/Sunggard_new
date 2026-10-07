import Parcel from "../../models/parcel.js";
import {
  LEDGER_STATUS,
  LEDGER_TRANSACTION_TYPE,
  OWNER_TYPE,
  PAYMENT_MODE,
} from "../../constants/finance.js";
import { creditWallet, debitWallet, getCustomerBalance } from "../finance/walletService.js";
import { pushCustomerTransaction, recordPorterLedgerEntry } from "./customerLedgerService.js";
import logger from "../logger.js";

/**
 * Paying for a courier booking out of the customer's wallet — and putting the
 * money back in the wallet if the booking is cancelled.
 *
 * Both directions are exactly-once. The parcel itself carries the guard
 * (`walletPayment.paidAt` / `.refundedAt`), claimed atomically BEFORE the
 * wallet moves, so a double-tap, a retried request or a cancel racing the
 * stalled-booking sweep can never debit or credit twice. If the wallet call
 * then fails, the claim is released so the operation can be retried.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const shortId = (id) => String(id).slice(-6).toUpperCase();

const httpError = (message, statusCode, code, extra = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
};

const INSUFFICIENT_MESSAGE =
  "Not enough wallet balance for this booking. Add money to your wallet or choose another payment method.";

/** What the customer is actually charged (coupon already taken off). */
export const bookingPayableAmount = (parcel) =>
  round2(Number(parcel?.payableFare) || Number(parcel?.fare) || 0);

/** Refuse early, before a booking row exists, if the wallet cannot cover it. */
export async function assertWalletCovers(customerId, amount) {
  const balance = await getCustomerBalance(customerId);
  if (round2(balance) + 0.0001 < round2(amount)) {
    throw httpError(INSUFFICIENT_MESSAGE, 402, "INSUFFICIENT_WALLET", {
      balance: round2(balance),
      required: round2(amount),
    });
  }
  return balance;
}

/**
 * Debit the wallet for a freshly created WALLET booking and mark it paid.
 * Throws (and leaves the parcel unpaid) if the wallet cannot cover it — the
 * caller removes the booking.
 */
export async function payBookingFromWallet(parcel) {
  const amount = bookingPayableAmount(parcel);
  if (!(amount > 0)) throw httpError("This booking has no amount to pay", 400);

  const claimed = await Parcel.findOneAndUpdate(
    {
      _id: parcel._id,
      paymentMethod: "WALLET",
      paymentStatus: { $ne: "PAID" },
      "walletPayment.paidAt": null,
    },
    { $set: { "walletPayment.paidAt": new Date(), "walletPayment.amount": amount } },
    { new: true },
  );
  if (!claimed) {
    // Already paid by an earlier call — nothing to debit.
    return Parcel.findById(parcel._id);
  }

  const reference = `PORTER-WALLET-PAY-${String(parcel._id)}`;
  try {
    await debitWallet({
      ownerType: OWNER_TYPE.CUSTOMER,
      ownerId: parcel.customerId,
      amount,
      ledgerType: LEDGER_TRANSACTION_TYPE.WALLET_PAYMENT,
      ledgerStatus: LEDGER_STATUS.COMPLETED,
      ledgerReference: reference,
      ledgerDescription: `Courier booking #${shortId(parcel._id)} (wallet)`,
      paymentMode: PAYMENT_MODE.ONLINE,
      metadata: { kind: "parcel_wallet_payment", parcelId: String(parcel._id) },
      idempotencyKey: `parcel-wallet-pay:${String(parcel._id)}`,
    });
  } catch (error) {
    await Parcel.updateOne(
      { _id: parcel._id },
      { $set: { "walletPayment.paidAt": null, "walletPayment.amount": 0 } },
    );
    if (/insufficient/i.test(error?.message || "")) {
      throw httpError(INSUFFICIENT_MESSAGE, 402, "INSUFFICIENT_WALLET");
    }
    throw error;
  }

  const paid = await Parcel.findByIdAndUpdate(
    parcel._id,
    { $set: { paymentStatus: "PAID" } },
    { new: true },
  );

  // Platform ledger row (same reference as the wallet ledger entry, so the
  // customer's history shows it once) and the customer's own strip.
  await Promise.all([
    recordPorterLedgerEntry({
      customerId: parcel.customerId,
      reference,
      type: "Courier Payment",
      amount,
      status: "Settled",
      meta: {
        source: "porter_wallet_payment",
        bookingId: String(parcel._id),
        referenceId: `PCL-${shortId(parcel._id)}`,
      },
    }),
    pushCustomerTransaction(parcel.customerId, {
      refId: parcel._id,
      refModel: "Parcel",
      kind: "WALLET_PAYMENT",
      source: "parcel",
      reference: `PCL-${shortId(parcel._id)}`,
      amount,
      status: "PAID",
      method: "wallet",
      note: "Courier booking paid from wallet",
    }),
  ]);

  logger.info("parcel_paid_from_wallet", {
    parcelId: String(parcel._id),
    customerId: String(parcel.customerId),
    amount,
  });
  return paid;
}

/**
 * Put a cancelled WALLET booking's money back into the customer's wallet.
 *
 * Returns null when this is not a paid wallet booking (the caller carries on
 * with the gateway refund path), otherwise a result shaped like
 * refundBookingPayment's, with `via: "WALLET"`.
 */
export async function refundWalletBooking({ parcelId, reason = "Booking cancelled" }) {
  const claimed = await Parcel.findOneAndUpdate(
    {
      _id: parcelId,
      paymentMethod: "WALLET",
      paymentStatus: "PAID",
      "walletPayment.refundedAt": null,
    },
    { $set: { "walletPayment.refundedAt": new Date(), paymentStatus: "REFUNDED" } },
    { new: true },
  );
  if (!claimed) return null;

  const amount = round2(claimed.walletPayment?.amount || bookingPayableAmount(claimed));
  const reference = `PORTER-WALLET-RFD-${String(claimed._id)}`;

  try {
    await creditWallet({
      ownerType: OWNER_TYPE.CUSTOMER,
      ownerId: claimed.customerId,
      amount,
      ledgerType: LEDGER_TRANSACTION_TYPE.WALLET_REFUND,
      ledgerStatus: LEDGER_STATUS.COMPLETED,
      ledgerReference: reference,
      ledgerDescription: `Refund for cancelled courier #${shortId(claimed._id)}`,
      paymentMode: PAYMENT_MODE.ONLINE,
      metadata: { kind: "parcel_wallet_refund", parcelId: String(claimed._id), reason },
      idempotencyKey: `parcel-wallet-refund:${String(claimed._id)}`,
    });
  } catch (error) {
    // Release the claim so the refund can be retried; the customer must not
    // be left cancelled, charged and un-refunded.
    await Parcel.updateOne(
      { _id: claimed._id },
      { $set: { "walletPayment.refundedAt": null, paymentStatus: "PAID" } },
    );
    logger.error("parcel_wallet_refund_failed", {
      parcelId: String(claimed._id),
      message: error?.message,
    });
    return {
      attempted: true,
      ok: false,
      via: "WALLET",
      error: error?.message || "Wallet refund failed",
      amountRupees: amount,
    };
  }

  await pushCustomerTransaction(claimed.customerId, {
    refId: claimed._id,
    refModel: "Parcel",
    kind: "REFUND",
    source: "parcel",
    reference: `PCL-${shortId(claimed._id)}`,
    amount: -amount,
    status: "REFUNDED",
    method: "wallet",
    note: reason,
  });

  logger.info("parcel_wallet_refunded", {
    parcelId: String(claimed._id),
    customerId: String(claimed.customerId),
    amount,
  });

  return {
    attempted: true,
    ok: true,
    via: "WALLET",
    status: "REFUNDED",
    gatewayStatus: "processed",
    amountPaise: Math.round(amount * 100),
    amountRupees: amount,
    booking: claimed,
  };
}
