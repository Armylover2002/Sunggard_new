import PorterPayment from "../../models/porterPayment.js";
import {
  PORTER_PAYER_TYPE,
  PORTER_PAYMENT_PURPOSE,
  PORTER_PAYMENT_SOURCE,
  PORTER_PAYMENT_STATUS,
} from "../../constants/porterPayment.js";
import {
  LEDGER_STATUS,
  LEDGER_TRANSACTION_TYPE,
  OWNER_TYPE,
  PAYMENT_MODE,
} from "../../constants/finance.js";
import { getActivePaymentProvider } from "../payment/providerRegistry.js";
import { creditWallet, getCustomerBalance } from "../finance/walletService.js";
import { applyPorterStatus, absorbGatewayEntity } from "./porterPaymentService.js";
import { pushCustomerTransaction } from "./customerLedgerService.js";
import logger from "../logger.js";

/**
 * A customer adding money to their wallet through the gateway.
 *
 * The one rule that matters: the wallet is credited only AFTER the gateway
 * has captured the money. Opening the checkout, a signed receipt on its own,
 * or an authorised-but-uncaptured payment credit nothing. The same two-step
 * the booking and rider-deposit payments use applies here — verify the
 * receipt signature, then read the real status back from the gateway — and
 * the webhook / reconciliation sweep reach the same credit independently, so
 * a customer whose app died after paying still gets their money.
 *
 * Crediting is exactly-once. A verify and a webhook routinely land together,
 * so `walletCreditedAt` is claimed atomically BEFORE the wallet is touched;
 * whoever loses the claim does nothing.
 */

export const WALLET_TOPUP_MIN_RUPEES = () =>
  Number(process.env.WALLET_TOPUP_MIN_RUPEES || 10);
export const WALLET_TOPUP_MAX_RUPEES = () =>
  Number(process.env.WALLET_TOPUP_MAX_RUPEES || 50000);

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);

const httpError = (message, statusCode, code) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
};

/** The amount comes from the client, so it is validated, never trusted. */
export function parseTopupAmount(raw) {
  const rupees = round2(raw);
  const min = WALLET_TOPUP_MIN_RUPEES();
  const max = WALLET_TOPUP_MAX_RUPEES();
  if (!Number.isFinite(Number(raw)) || !(rupees > 0)) {
    throw httpError("Enter a valid amount", 400);
  }
  if (rupees < min) throw httpError(`Minimum top-up is ₹${min}`, 400);
  if (rupees > max) throw httpError(`Maximum top-up is ₹${max.toLocaleString("en-IN")}`, 400);
  return rupees;
}

export async function openWalletTopup({ customerId, amountRupees, correlationId = null }) {
  const rupees = parseTopupAmount(amountRupees);
  const amountPaise = toPaise(rupees);

  const provider = getActivePaymentProvider();
  if (!provider.isConfigured()) {
    throw httpError(
      "Adding money is unavailable right now. Please try again later.",
      503,
      "GATEWAY_NOT_CONFIGURED",
    );
  }

  const attemptCount =
    (await PorterPayment.countDocuments({
      customerId,
      purpose: PORTER_PAYMENT_PURPOSE.WALLET_TOPUP,
    })) + 1;
  const merchantReference = `PTR-WTU-${String(customerId).slice(-12)}-A${attemptCount}-${Date.now()
    .toString(36)
    .slice(-4)}`.slice(0, 40);

  // Written before the gateway call so a failure to open the order still
  // leaves a truthful row instead of an order nobody can match to a customer.
  const payment = await PorterPayment.create({
    purpose: PORTER_PAYMENT_PURPOSE.WALLET_TOPUP,
    payerType: PORTER_PAYER_TYPE.CUSTOMER,
    customerId,
    referenceId: merchantReference,
    gatewayName: provider.providerName,
    merchantReference,
    amount: amountPaise,
    currency: "INR",
    status: PORTER_PAYMENT_STATUS.CREATED,
    attemptCount,
    correlationId,
    notes: { purpose: PORTER_PAYMENT_PURPOSE.WALLET_TOPUP, customerId: String(customerId) },
  });

  try {
    const init = await provider.initiatePayment({
      merchantOrderId: merchantReference,
      amountPaise,
      currency: "INR",
      notes: {
        purpose: PORTER_PAYMENT_PURPOSE.WALLET_TOPUP,
        customerId: String(customerId),
      },
    });

    payment.gatewayOrderId = init.gatewayOrderId;
    payment.rawGatewayResponse = { order: init.gatewayResponse };
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.PENDING,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: "Wallet top-up checkout opened",
    });
    await payment.save();

    return { payment, checkout: init.checkout, amount: rupees };
  } catch (error) {
    applyPorterStatus(payment, {
      nextStatus: PORTER_PAYMENT_STATUS.FAILED,
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
      reason: `Could not open the top-up order: ${error?.message || "unknown"}`,
    });
    payment.failureReason = error?.message || "Could not start the top-up";
    await payment.save().catch(() => {});
    throw error;
  }
}

/**
 * Credit a captured top-up to the wallet. Safe to call from every path
 * (verify, webhook, reconciliation) any number of times.
 */
export async function applyWalletTopupSideEffects(payment) {
  if (payment.purpose !== PORTER_PAYMENT_PURPOSE.WALLET_TOPUP) return null;
  if (!payment.isPaid()) return null;
  if (payment.walletCreditedAt) return { credited: false, duplicate: true };

  const claimed = await PorterPayment.findOneAndUpdate(
    { _id: payment._id, walletCreditedAt: null },
    { $set: { walletCreditedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return { credited: false, duplicate: true };

  const rupees = round2(claimed.amount / 100);
  try {
    await creditWallet({
      ownerType: OWNER_TYPE.CUSTOMER,
      ownerId: claimed.customerId,
      amount: rupees,
      ledgerType: LEDGER_TRANSACTION_TYPE.WALLET_TOPUP,
      ledgerStatus: LEDGER_STATUS.COMPLETED,
      ledgerReference: `WALLET-TOPUP-${String(claimed._id)}`,
      ledgerDescription: "Wallet top-up",
      paymentMode: PAYMENT_MODE.ONLINE,
      metadata: {
        kind: "wallet_topup",
        paymentId: String(claimed._id),
        gatewayPaymentId: claimed.gatewayPaymentId || "",
        method: claimed.instrument?.method || "",
      },
      idempotencyKey: `wallet-topup:${String(claimed._id)}`,
    });
  } catch (error) {
    // Give the claim back so a retry (or the reconciliation sweep) can try
    // again — a captured payment must never end up uncredited.
    await PorterPayment.updateOne({ _id: claimed._id }, { $set: { walletCreditedAt: null } });
    logger.error("wallet_topup_credit_failed", {
      paymentId: String(claimed._id),
      message: error?.message,
    });
    throw error;
  }

  await pushCustomerTransaction(claimed.customerId, {
    refId: claimed._id,
    refModel: "PorterPayment",
    kind: "WALLET_TOPUP",
    source: "wallet",
    reference: `WALLET-TOPUP-${String(claimed._id)}`,
    amount: rupees,
    currency: claimed.currency,
    status: claimed.status,
    method: claimed.instrument?.method || "",
    gatewayPaymentId: claimed.gatewayPaymentId || "",
    note: "Added to wallet",
  });

  logger.info("wallet_topup_credited", {
    paymentId: String(claimed._id),
    customerId: String(claimed.customerId),
    amount: rupees,
  });

  return { credited: true, amount: rupees };
}

/**
 * Verify the checkout receipt, read the real status back, then credit.
 */
export async function verifyWalletTopupReceipt({
  customerId,
  gatewayOrderId,
  gatewayPaymentId,
  signature,
  correlationId = null,
}) {
  const payment = await PorterPayment.findOne({
    purpose: PORTER_PAYMENT_PURPOSE.WALLET_TOPUP,
    customerId,
    gatewayOrderId,
  });
  if (!payment) throw httpError("No top-up attempt found", 404);

  if (payment.isPaid()) {
    const result = await applyWalletTopupSideEffects(payment);
    return { payment, ...result, balance: await getCustomerBalance(customerId), duplicate: true };
  }

  const provider = getActivePaymentProvider();
  const ok = provider.verifyCheckoutSignature({
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId,
    signature,
  });
  if (!ok) {
    logger.warn("wallet_topup_receipt_invalid", { paymentId: String(payment._id) });
    throw httpError("This payment could not be verified", 400, "INVALID_SIGNATURE");
  }

  payment.gatewaySignature = signature;
  payment.correlationId = correlationId || payment.correlationId;

  const statusResp = await provider.getPaymentStatus({
    gatewayOrderId: payment.gatewayOrderId,
    merchantOrderId: payment.merchantReference,
  });
  const entity =
    (statusResp.gatewayResponse?.payments || []).find((p) => p.id === statusResp.transactionId) ||
    null;
  absorbGatewayEntity(payment, entity);
  if (statusResp.transactionId) payment.gatewayPaymentId = statusResp.transactionId;

  applyPorterStatus(payment, {
    nextStatus: provider.mapStatusToInternal(statusResp.state),
    source: PORTER_PAYMENT_SOURCE.CLIENT_VERIFY,
    reason: `Gateway reports ${statusResp.state}`,
    gatewayState: statusResp.state,
  });
  await payment.save();

  if (!payment.isPaid()) {
    throw httpError(
      payment.status === PORTER_PAYMENT_STATUS.FAILED
        ? payment.errorDescription || "The payment failed. Nothing was added to your wallet."
        : "Your bank has not confirmed the payment yet. Your wallet will update as soon as it does.",
      payment.status === PORTER_PAYMENT_STATUS.FAILED ? 402 : 202,
    );
  }

  const result = await applyWalletTopupSideEffects(payment);
  return { payment, ...result, balance: await getCustomerBalance(customerId) };
}
