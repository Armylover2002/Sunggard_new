/**
 * DeliveryEarningsService
 *
 * Owns the read-side aggregations for the delivery partner's dashboard:
 *   - getDeliveryStats         ← getDeliveryStats handler
 *   - getDeliveryEarnings      ← getDeliveryEarnings handler
 *   - getDeliveryCodCashSummary ← getDeliveryCodCashSummary handler
 *
 * Framework-agnostic. Inputs are primitives; output shapes match the
 * existing HTTP response payloads byte-for-byte so frontend consumers see
 * no change.
 *
 * Throws errors with `err.statusCode` for the auth-failure cases the COD
 * summary handler used to handle inline.
 */

import mongoose from "mongoose";
import Transaction from "../../models/transaction.js";
import Wallet from "../../models/wallet.js";
import Parcel from "../../models/parcel.js";
import { roundCurrency } from "../../utils/money.js";
import { buildKey, getOrSet, getTTL, invalidate } from "../cacheService.js";
import { backfillMissingParcelEarnings } from "../parcelRiderSettlementService.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function svcErr(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toDeliveryBoyId(rawId) {
  if (rawId == null) {
    throw svcErr("Unauthorized", 401);
  }
  if (!mongoose.Types.ObjectId.isValid(String(rawId))) {
    throw svcErr("Invalid user id", 401);
  }
  return new mongoose.Types.ObjectId(String(rawId));
}

/**
 * Dashboard summary: total deliveries, today's earnings, incentives, cash in hand.
 * Cached for ~30s (`deliveryStats` TTL) to absorb dashboard polling.
 */
export async function getDeliveryStats(rawId) {
  const deliveryBoyId = toDeliveryBoyId(rawId);
  const cacheKey = buildKey("delivery", "stats", String(deliveryBoyId));

  // Backfill before cache so past parcel deliveries show up immediately.
  try {
    const created = await backfillMissingParcelEarnings(deliveryBoyId);
    if (created > 0) {
      await Promise.all([
        invalidate(cacheKey),
        invalidate(buildKey("delivery", "earnings", String(deliveryBoyId))),
      ]);
    }
  } catch {
    /* non-blocking */
  }

  return getOrSet(
    cacheKey,
    () => computeDeliveryStats(deliveryBoyId),
    getTTL("deliveryStats"),
  );
}

async function computeDeliveryStats(deliveryBoyId) {
  const parcelDeliveries = await Parcel.find({
    deliveryPartnerId: deliveryBoyId,
    status: "DELIVERED",
  })
    .select("_id")
    .lean();
  const totalDeliveries = parcelDeliveries.length;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const allTransactions = await Transaction.find({
    user: deliveryBoyId,
    userModel: "Delivery",
    createdAt: { $gte: startOfToday },
  }).lean();

  const todayEarnings = allTransactions
    .filter(
      (t) =>
        t.status === "Settled" &&
        (t.type === "Delivery Earning" ||
          t.type === "Incentive" ||
          t.type === "Bonus"),
    )
    .reduce((acc, t) => acc + t.amount, 0);

  const incentives = allTransactions
    .filter(
      (t) =>
        t.status === "Settled" &&
        (t.type === "Incentive" || t.type === "Bonus"),
    )
    .reduce((acc, t) => acc + t.amount, 0);

  const wallet = await Wallet.findOne({
    ownerType: "DELIVERY_PARTNER",
    ownerId: deliveryBoyId,
  })
    .select("cashInHand")
    .lean();
  const cashCollected = roundCurrency(wallet?.cashInHand || 0);

  return {
    today: todayEarnings,
    deliveries: totalDeliveries,
    incentives,
    cashCollected,
  };
}

/**
 * Earnings page payload: totals, 7-day chart, latest 20 transactions.
 * Cached for ~30s (`deliveryEarnings` TTL) to absorb dashboard polling.
 */
export async function getDeliveryEarnings(rawId) {
  const deliveryBoyId = toDeliveryBoyId(rawId);
  const cacheKey = buildKey("delivery", "earnings", String(deliveryBoyId));

  // Backfill before cache so past parcel deliveries show up immediately.
  try {
    const created = await backfillMissingParcelEarnings(deliveryBoyId);
    if (created > 0) {
      await Promise.all([
        invalidate(cacheKey),
        invalidate(buildKey("delivery", "stats", String(deliveryBoyId))),
      ]);
    }
  } catch {
    /* non-blocking */
  }

  return getOrSet(
    cacheKey,
    () => computeDeliveryEarnings(deliveryBoyId),
    getTTL("deliveryEarnings"),
  );
}

async function computeDeliveryEarnings(deliveryBoyId) {
  const transactions = await Transaction.find({
    user: deliveryBoyId,
    userModel: "Delivery",
  })
    .sort({ createdAt: -1 })
    .limit(200);

  const wallet = await Wallet.findOne({
    ownerType: "DELIVERY_PARTNER",
    ownerId: deliveryBoyId,
  })
    .select("cashInHand")
    .lean();

  const totalEarnings = transactions
    .filter(
      (t) =>
        t.status === "Settled" &&
        (t.type === "Delivery Earning" ||
          t.type === "Incentive" ||
          t.type === "Bonus"),
    )
    .reduce((acc, t) => acc + t.amount, 0);

  const tipsReceived = transactions
    .filter((t) => t.type === "Delivery Earning" && t.status === "Settled")
    .reduce((acc, t) => acc + Number(t?.meta?.tipAmount ?? 0), 0);

  const onlinePay = transactions
    .filter((t) => t.type === "Delivery Earning" && t.status === "Settled")
    .reduce((acc, t) => acc + t.amount, 0);

  const incentives = transactions
    .filter(
      (t) =>
        (t.type === "Incentive" || t.type === "Bonus") && t.status === "Settled",
    )
    .reduce((acc, t) => acc + t.amount, 0);

  const withdrawnTotal = transactions
    .filter((t) => t.type === "Withdrawal" && t.status === "Settled")
    .reduce((acc, t) => acc + Math.abs(Number(t.amount) || 0), 0);

  const pendingWithdrawals = transactions
    .filter(
      (t) =>
        t.type === "Withdrawal" &&
        (t.status === "Pending" || t.status === "Processing"),
    )
    .reduce((acc, t) => acc + Math.abs(Number(t.amount) || 0), 0);

  const availableBalance = roundCurrency(
    Math.max(0, totalEarnings - withdrawnTotal - pendingWithdrawals),
  );

  const cashCollected = roundCurrency(wallet?.cashInHand || 0);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const dailyAggregation = await Transaction.aggregate([
    {
      $match: {
        user: deliveryBoyId,
        userModel: "Delivery",
        status: "Settled",
        createdAt: { $gte: sevenDaysAgo },
        type: { $in: ["Delivery Earning", "Incentive", "Bonus"] },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        amount: { $sum: "$amount" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const chartData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const foundAt = dailyAggregation.find((a) => a._id === dateStr);
    chartData.push({
      name: DAY_NAMES[d.getDay()],
      earnings: foundAt ? foundAt.amount : 0,
      incentives: 0,
    });
  }

  return {
    totalEarnings,
    availableBalance,
    withdrawnTotal,
    pendingWithdrawals,
    onlinePay,
    incentives,
    tipsReceived,
    cashCollected,
    chartData,
    transactions: transactions.slice(0, 20),
  };
}

// getDeliveryCodCashSummary/computeDeliveryCodCashSummary (Order/COD-based)
// removed with QC. Porter's rider COD cash flow (Parcel `codSettlement` +
// `CashDeposit` review) is served by `services/riderCashService.js` instead.

export default {
  getDeliveryStats,
  getDeliveryEarnings,
};
