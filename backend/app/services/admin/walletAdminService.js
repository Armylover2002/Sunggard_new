import Transaction from "../../models/transaction.js";
import Notification from "../../models/notification.js";
import { translate, normalizeLanguage } from "../../modules/notifications/notification.i18n.js";
import { getOrCreateWallet } from "../finance/walletService.js";
import { OWNER_TYPE } from "../../constants/finance.js";
import { addMoney, roundCurrency } from "../../utils/money.js";
import { buildKey, invalidate } from "../cacheService.js";
import { getFleetCashHoldings } from "../riderCashService.js";

export async function getDeliveryTransactionsData({ page, limit, skip }) {
  const query = { userModel: "Delivery" };
  const transactions = await Transaction.find(query)
    .populate("user", "name phone documents")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const total = await Transaction.countDocuments(query);

  // Headline figures over the whole ledger, not just this page. Earnings
  // and cash collections are "Settled" on the ledger once they are credited
  // or booked, which is not money leaving the platform — so the figures the
  // admin acts on are withdrawals actually paid, withdrawals still waiting,
  // and cash riders are still holding.
  const [withdrawalAgg, riderIds, holdings] = await Promise.all([
    Transaction.aggregate([
      { $match: { userModel: "Delivery", type: "Withdrawal" } },
      { $group: { _id: "$status", amount: { $sum: { $abs: "$amount" } } } },
    ]),
    Transaction.distinct("user", query),
    getFleetCashHoldings().catch(() => ({ totalHeld: 0 })),
  ]);
  const withdrawalTotal = (statuses) =>
    roundCurrency(
      withdrawalAgg
        .filter((row) => statuses.includes(row._id))
        .reduce((sum, row) => sum + (row.amount || 0), 0),
    );

  return {
    items: transactions,
    summary: {
      paidOut: withdrawalTotal(["Settled"]),
      pendingPayouts: withdrawalTotal(["Pending", "Processing"]),
      cashWithRiders: roundCurrency(holdings.totalHeld || 0),
      riders: riderIds.length,
    },
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
        "name phone profileImage vehicleType vehicleNumber accountHolder accountNumber ifsc bankName upiId qrImageUrl",
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
  // Cash a rider collected is settled by approving their cash deposit, which
  // also moves the booking to REMITTED_TO_ADMIN. Flipping just this ledger
  // row would say the cash is in while the booking says the rider holds it.
  const existing = await Transaction.findById(id).select("type").lean();
  if (existing?.type === "Cash Collection") {
    const err = new Error(
      "Collected cash is settled by approving the rider's cash deposit, not from here.",
    );
    err.statusCode = 400;
    throw err;
  }

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
    // Pending "Cash Collection" rows are cash still with a rider; they settle
    // when a deposit is approved, never in bulk.
    { userModel: "Delivery", status: "Pending", type: { $ne: "Cash Collection" } },
    { status: "Settled" },
  );
}
