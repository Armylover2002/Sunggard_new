import Transaction from "../../models/transaction.js";

/**
 * One definition of "admin earning" for every porter money screen.
 *
 * A delivered booking only becomes the platform's money once the cash is
 * actually with the platform:
 *   - online (UPI / card / wallet): paid up front, so on delivery;
 *   - COD: the rider collects it at the door and holds it until a cash
 *     deposit is approved (Parcel.codSettlement.status -> REMITTED_TO_ADMIN,
 *     see riderCashService.markItemsRemitted). Until then it is the rider's
 *     cash, not admin earning.
 *
 * Rider earning is different: it is owed the moment the delivery completes
 * (it is credited to the rider's wallet), so it is subtracted either way.
 * What the rider has actually been PAID is only what the admin has settled
 * as withdrawals.
 *
 * Read-only: nothing here writes to a parcel, a ledger row or a wallet.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Aggregation predicate: this delivered booking's money has reached admin. */
export const CASH_WITH_ADMIN = {
  $or: [
    { $ne: ["$paymentMethod", "COD"] },
    { $eq: ["$codSettlement.status", "REMITTED_TO_ADMIN"] },
  ],
};

const LINE_ITEMS = {
  baseFare: { $ifNull: ["$fareBreakdown.baseFare", 0] },
  weightFare: { $ifNull: ["$fareBreakdown.weightFare", 0] },
  expressCharge: { $ifNull: ["$fareBreakdown.expressCharge", 0] },
  courierCharge: { $ifNull: ["$fareBreakdown.courierCharge", 0] },
  gstAmount: { $ifNull: ["$fareBreakdown.gstAmount", 0] },
  fare: "$fare",
};

/**
 * `$group` stage for DELIVERED parcels, every line item split into what has
 * reached admin (`r_*`) and what is still with riders (`p_*`).
 */
export const buildDeliveredMoneyGroup = () => {
  const group = {
    _id: null,
    delivered: { $sum: 1 },
    distanceKm: { $sum: "$distance" },
    // Which parcels' cash is with admin — feeds the rider-earning lookup.
    parcels: { $push: { id: "$_id", received: CASH_WITH_ADMIN } },
    // Gateway (UPI / card) and wallet payments are both received up front;
    // they are split only so the admin can see where the money came from.
    onlineFare: {
      $sum: {
        $cond: [{ $not: [{ $in: ["$paymentMethod", ["COD", "WALLET"]] }] }, "$fare", 0],
      },
    },
    walletFare: {
      $sum: { $cond: [{ $eq: ["$paymentMethod", "WALLET"] }, "$fare", 0] },
    },
  };
  for (const [key, expr] of Object.entries(LINE_ITEMS)) {
    group[`r_${key}`] = { $sum: { $cond: [CASH_WITH_ADMIN, expr, 0] } };
    group[`p_${key}`] = { $sum: { $cond: [CASH_WITH_ADMIN, 0, expr] } };
  }
  return { $group: group };
};

/** Splits the `parcels` array the group above pushed into two id lists. */
export const splitParcelIds = (totals = {}) => {
  const realizedIds = [];
  const pendingIds = [];
  for (const row of totals.parcels || []) {
    (row.received ? realizedIds : pendingIds).push(String(row.id));
  }
  return { realizedIds, pendingIds };
};

async function earnedByRider(parcelIds) {
  const map = new Map();
  if (!parcelIds.length) return map;
  const rows = await Transaction.aggregate([
    {
      $match: {
        userModel: "Delivery",
        type: "Delivery Earning",
        "meta.parcelId": { $in: parcelIds },
      },
    },
    { $group: { _id: "$user", amount: { $sum: "$amount" } } },
  ]);
  for (const row of rows || []) map.set(String(row._id), { id: row._id, amount: row.amount || 0 });
  return map;
}

/**
 * What riders earned on these deliveries, and how much of it has actually
 * been paid out.
 *
 * `paid` caps each rider's settled withdrawals at their earning here. A
 * rider's withdrawals draw on one pool shared with other work, so it cannot
 * be attributed exactly — the cap just guarantees we never report more paid
 * than was earned on these bookings.
 */
export async function computeRiderMoney(realizedIds, pendingIds) {
  const [realizedMap, pendingMap] = await Promise.all([
    earnedByRider(realizedIds),
    earnedByRider(pendingIds),
  ]);

  const sum = (map) => [...map.values()].reduce((s, r) => s + r.amount, 0);
  const totals = new Map();
  for (const map of [realizedMap, pendingMap]) {
    for (const [key, row] of map) {
      const existing = totals.get(key);
      totals.set(key, { id: row.id, amount: (existing?.amount || 0) + row.amount });
    }
  }

  let paid = 0;
  if (totals.size) {
    const withdrawn = await Transaction.aggregate([
      {
        $match: {
          userModel: "Delivery",
          type: "Withdrawal",
          status: "Settled",
          user: { $in: [...totals.values()].map((r) => r.id) },
        },
      },
      { $group: { _id: "$user", amount: { $sum: { $abs: "$amount" } } } },
    ]);
    const withdrawnByRider = new Map((withdrawn || []).map((r) => [String(r._id), r.amount || 0]));
    for (const [key, row] of totals) {
      paid += Math.min(row.amount, withdrawnByRider.get(key) || 0);
    }
  }

  const realizedEarned = sum(realizedMap);
  const pendingEarned = sum(pendingMap);
  const earned = realizedEarned + pendingEarned;
  return {
    realizedEarned: round2(realizedEarned),
    pendingEarned: round2(pendingEarned),
    earned: round2(earned),
    paid: round2(paid),
    owed: round2(Math.max(0, earned - paid)),
  };
}

/**
 * Turns the group totals + rider money into the figures the screens show.
 * GST is excluded from earning: it is the government's money.
 */
export function buildEarnings(totals = {}, riderMoney = {}) {
  const side = (prefix, riderEarning) => {
    const delivery = round2(totals[`${prefix}_baseFare`]);
    const weight = round2(totals[`${prefix}_weightFare`]);
    const express = round2(totals[`${prefix}_expressCharge`]);
    const courier = round2(totals[`${prefix}_courierCharge`]);
    const charges = round2(delivery + weight + express + courier);
    return {
      billed: round2(totals[`${prefix}_fare`]),
      delivery,
      weight,
      express,
      courier,
      gst: round2(totals[`${prefix}_gstAmount`]),
      charges,
      riderEarning: round2(riderEarning),
      earning: Math.max(0, round2(charges - riderEarning)),
    };
  };

  const realized = side("r", riderMoney.realizedEarned || 0);
  const pending = side("p", riderMoney.pendingEarned || 0);
  const onlineFare = round2(totals.onlineFare);
  const walletFare = round2(totals.walletFare);
  return {
    realized,
    pending,
    // Admin received: online + wallet in full + COD that has been deposited.
    received: {
      online: onlineFare,
      wallet: walletFare,
      cod: round2(realized.billed - onlineFare - walletFare),
    },
    cashWithRiders: pending.billed,
  };
}
