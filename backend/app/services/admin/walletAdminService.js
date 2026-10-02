import Transaction from "../../models/transaction.js";
import Notification from "../../models/notification.js";
import { getOrCreateWallet } from "../finance/walletService.js";
import { getLedgerEntries } from "../finance/ledgerService.js";
import { OWNER_TYPE } from "../../constants/finance.js";
import { addMoney, roundCurrency } from "../../utils/money.js";
import { buildKey, invalidate } from "../cacheService.js";

export async function getAdminWalletOverview({ page, limit }) {
  const adminWallet = await getOrCreateWallet(OWNER_TYPE.ADMIN, null);
  const ledger = await getLedgerEntries({ page, limit });
  const transactionItems = ledger.items.map((entry) => ({
    id: entry.transactionId || entry.reference || String(entry._id),
    type: entry.type,
    amount:
      entry.direction === "DEBIT"
        ? -Math.abs(entry.amount || 0)
        : Math.abs(entry.amount || 0),
    status: entry.status,
    sender: entry.direction === "DEBIT" ? entry.actorType : "System/Order",
    recipient: entry.direction === "CREDIT" ? entry.actorType : "Platform Wallet",
    date: new Date(entry.createdAt).toLocaleDateString(),
    time: new Date(entry.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    notes: entry.description || entry.type,
    method: entry.paymentMode || "N/A",
  }));

  return {
    stats: {
      availableBalance: roundCurrency(adminWallet.availableBalance || 0),
      totalCredited: roundCurrency(adminWallet.totalCredited || 0),
      totalDebited: roundCurrency(adminWallet.totalDebited || 0),
      systemFloat: roundCurrency(adminWallet.cashInHand || 0),
    },
    transactions: {
      items: transactionItems,
      page: ledger.page,
      limit: ledger.limit,
      total: ledger.total,
      totalPages: ledger.totalPages,
    },
  };
}

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

export async function getSellerWithdrawalsData({ page, limit, skip }) {
  const query = { userModel: "Seller", type: "Withdrawal" };

  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      .populate("user", "name shopName phone")
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

  const transaction = await Transaction.findById(id).populate("user", "name");
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
    await Notification.create({
      recipient: userId,
      recipientModel: transaction.userModel,
      title: "Withdrawal Approved",
      message: `Your withdrawal of \u20B9${amount} has been approved and settled.`,
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
  ).populate("user", "name");

  if (!transaction) {
    return null;
  }

  await Notification.create({
    recipient: transaction.user._id,
    recipientModel: "Delivery",
    title: "Payment Settled",
    message: `Your payment of \u20B9${transaction.amount} has been settled.`,
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
