import Transaction from "../../models/transaction.js";
import Notification from "../../models/notification.js";
import { translate, normalizeLanguage } from "../../modules/notifications/notification.i18n.js";
import { getOrCreateWallet } from "../finance/walletService.js";
import { OWNER_TYPE } from "../../constants/finance.js";
import { addMoney, roundCurrency } from "../../utils/money.js";
import { buildKey, invalidate } from "../cacheService.js";

export async function getDeliveryTransactionsData({ page, limit, skip }) {
  const query = { userModel: "Delivery" };
  const transactions = await Transaction.find(query)
    .populate("user", "name phone documents")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const total = await Transaction.countDocuments(query);

  return {
    items: transactions,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getDeliveryWithdrawalsData({ page, limit, skip }) {
  const query = { userModel: "Delivery", type: "Withdrawal" };

  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      // The payout destination has to travel with the request. Populating
      // only name+phone meant the admin approved a withdrawal without ever
      // seeing where the money was supposed to go.
      .populate(
        "user",
        "name phone accountHolder accountNumber ifsc bankName upiId qrImageUrl",
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(query),
  ]);

  return {
    items: transactions,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function updateWithdrawalStatusById({ id, status, reason }) {
  if (!["Settled", "Failed", "Processing"].includes(status)) {
    throw new Error("Invalid status");
  }

  const transaction = await Transaction.findById(id).populate("user", "name language");
  if (!transaction) {
    return null;
  }

  const previousStatus = transaction.status;
  transaction.status = status;
  if (reason) {
    transaction.notes = reason;
  }

  await transaction.save();

  // On first approval: mark wallet payout + invalidate rider caches so UI updates.
  if (
    status === "Settled" &&
    previousStatus !== "Settled" &&
    transaction.type === "Withdrawal"
  ) {
    await applySettledWithdrawalSideEffects(transaction);
  }

  return transaction;
}

async function applySettledWithdrawalSideEffects(transaction) {
  const amount = roundCurrency(Math.abs(Number(transaction.amount) || 0));
  const userId = transaction.user?._id || transaction.user;
  if (!(amount > 0) || !userId) return;

  const isDelivery = transaction.userModel === "Delivery";
  const ownerType = isDelivery
    ? OWNER_TYPE.DELIVERY_PARTNER
    : transaction.userModel === "Seller"
      ? OWNER_TYPE.SELLER
      : null;

  if (ownerType) {
    try {
      const wallet = await getOrCreateWallet(ownerType, userId);
      const available = roundCurrency(wallet.availableBalance || 0);
      // Delivery earnings often live only on Transaction rows, so available
      // may be 0 — still record totalDebited for wallet summary.
      const debitFromAvailable = Math.min(available, amount);
      wallet.availableBalance = roundCurrency(available - debitFromAvailable);
      wallet.totalDebited = addMoney(wallet.totalDebited || 0, amount);
      await wallet.save();
    } catch (err) {
      console.error(
        "[withdrawal] wallet debit failed:",
        err?.message || err,
      );
    }
  }

  if (isDelivery) {
    await Promise.all([
      invalidate(buildKey("delivery", "earnings", String(userId))),
      invalidate(buildKey("delivery", "stats", String(userId))),
    ]).catch(() => {});
  }

  try {
    // Only Customer/Delivery accounts carry a `language`; others (Seller,
    // Admin) have none, and normalizeLanguage falls back to English for them.
    const lang = normalizeLanguage(transaction.user?.language);
    await Notification.create({
      recipient: userId,
      recipientModel: transaction.userModel,
      title: translate(lang, "withdrawal_approved_title"),
      message: translate(lang, "withdrawal_approved_body", { amount }),
      type: "payment",
      data: { transactionId: transaction._id, reference: transaction.reference },
    });
  } catch {
    /* non-blocking */
  }
}

export async function settleDeliveryTransactionById(id) {
  const transaction = await Transaction.findByIdAndUpdate(
    id,
    { status: "Settled" },
    { new: true },
  ).populate("user", "name language");

  if (!transaction) {
    return null;
  }

  const lang = normalizeLanguage(transaction.user?.language);
  await Notification.create({
    recipient: transaction.user._id,
    recipientModel: "Delivery",
    title: translate(lang, "payment_settled_title"),
    message: translate(lang, "payment_settled_body", { amount: transaction.amount }),
    type: "payment",
    data: { transactionId: transaction._id },
  });

  return transaction;
}

export async function bulkSettleDeliveryTransactions() {
  return Transaction.updateMany(
    { userModel: "Delivery", status: "Pending" },
    { status: "Settled" },
  );
}
