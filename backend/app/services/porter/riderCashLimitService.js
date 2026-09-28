import mongoose from "mongoose";
import Delivery from "../../models/delivery.js";
import Setting from "../../models/setting.js";
import CashDeposit from "../../models/cashDeposit.js";
import Parcel from "../../models/parcel.js";
import logger from "../logger.js";

/**
 * How much COD cash a rider is allowed to be carrying, and what happens when
 * they hit it.
 *
 * The rule the business wants is simple and was entirely unimplemented: a
 * rider may hold up to a limit; once they reach it they stop being offered
 * work — local and outstation alike — until they deposit the cash and an
 * admin approves the deposit.
 *
 * What was there before: the admin cash screen aggregated
 * `{ $ifNull: ["$limit", 5000] }` over the Delivery collection. `limit` is
 * not a field on that model and never has been, so every rider read as
 * having exactly a ₹5,000 limit, nothing could change it, and nothing
 * enforced it. The number on screen was decoration.
 *
 * Two levels, resolved here and nowhere else:
 *   global     — Setting.porterCash.globalCashLimit, the fleet default.
 *   per-rider  — Delivery.cashLimit, an override for a specific rider.
 *                Null means "use the global one", which is different from
 *                zero (zero means this rider may carry no cash at all, which
 *                is a legitimate thing to want for a new joiner).
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const toOid = (id) =>
  mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;

/**
 * Outstation COD sits in one of two states that both mean "the rider has the
 * money". WITH_SELLER is counted as held for the same reason
 * services/riderCashService.js counts it: the old flow stamped it on every
 * COD parcel at hub drop-off including the ones with no seller at all, so
 * nobody could ever clear it and the cash was with the rider in reality.
 */
const HELD_PARCEL_STATUSES = ["RIDER_HOLDING", "WITH_SELLER"];

export const DEFAULT_GLOBAL_CASH_LIMIT = 5000;

/* ==========================================================================
   Configuration
   ========================================================================== */

/** The fleet-wide default, and whether the limit is enforced at all. */
export async function getPorterCashSettings() {
  const setting = await Setting.findOne({}).select("porterCash").lean();
  const porterCash = setting?.porterCash || {};

  return {
    /**
     * Off by default. Switching enforcement on is a decision with an
     * immediate operational consequence — riders currently over the limit
     * stop receiving work the moment it flips — so it must be a deliberate
     * act, never a field that defaulted to true on deploy.
     */
    enforceCashLimit: Boolean(porterCash.enforceCashLimit),
    globalCashLimit: Number.isFinite(Number(porterCash.globalCashLimit))
      ? round2(porterCash.globalCashLimit)
      : DEFAULT_GLOBAL_CASH_LIMIT,
    /**
     * The share of the limit at which the rider app starts warning them.
     * A rider who discovers the block by having jobs silently stop appearing
     * has been failed by the product.
     */
    warnAtPercent: Math.min(
      100,
      Math.max(0, Number(porterCash.warnAtPercent) || 80),
    ),
    /**
     * Whether an approved deposit is required, or a raised one is enough.
     * True is the business rule as stated: deposit, then admin approval, then
     * work resumes.
     */
    requireApprovalToResume: porterCash.requireApprovalToResume !== false,
  };
}

export async function updatePorterCashSettings(patch = {}) {
  const current = await getPorterCashSettings();
  const next = { ...current };

  if (patch.enforceCashLimit !== undefined) {
    next.enforceCashLimit = Boolean(patch.enforceCashLimit);
  }
  if (patch.globalCashLimit !== undefined) {
    const value = Number(patch.globalCashLimit);
    if (!Number.isFinite(value) || value < 0) {
      const err = new Error("The cash limit must be zero or more");
      err.statusCode = 400;
      throw err;
    }
    next.globalCashLimit = round2(value);
  }
  if (patch.warnAtPercent !== undefined) {
    const value = Number(patch.warnAtPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      const err = new Error("The warning threshold must be a percentage");
      err.statusCode = 400;
      throw err;
    }
    next.warnAtPercent = Math.round(value);
  }
  if (patch.requireApprovalToResume !== undefined) {
    next.requireApprovalToResume = Boolean(patch.requireApprovalToResume);
  }

  const setting = await Setting.findOneAndUpdate(
    {},
    { $set: { porterCash: next } },
    { new: true, upsert: true },
  ).lean();

  return setting.porterCash;
}

/**
 * Set or clear one rider's own limit.
 *
 * `null` clears the override and puts the rider back on the global limit.
 * That is deliberately distinct from `0`, which is a real limit meaning this
 * rider may not carry cash — a new joiner on probation, say. Collapsing the
 * two would make "no cash for this rider" impossible to express.
 */
export async function setRiderCashLimit(riderId, limit) {
  const oid = toOid(riderId);
  if (!oid) {
    const err = new Error("Unknown rider");
    err.statusCode = 400;
    throw err;
  }

  let value = null;
  if (limit !== null && limit !== undefined && String(limit).trim() !== "") {
    value = Number(limit);
    if (!Number.isFinite(value) || value < 0) {
      const err = new Error("The cash limit must be zero or more");
      err.statusCode = 400;
      throw err;
    }
    value = round2(value);
  }

  const rider = await Delivery.findByIdAndUpdate(
    oid,
    { $set: { cashLimit: value } },
    { new: true },
  )
    .select("name phone cashLimit")
    .lean();

  if (!rider) {
    const err = new Error("Rider not found");
    err.statusCode = 404;
    throw err;
  }

  return rider;
}

/* ==========================================================================
   Holdings
   ========================================================================== */

/**
 * What one rider is holding right now, in rupees.
 *
 * Summed from the BOOKINGS, not from the legacy Transaction ledger. The
 * ledger is dual-written and lossy — a job whose collection row failed to
 * write would silently lower the rider's balance and let them carry more cash
 * than the limit allows. The bookings are the fact.
 */
export async function getRiderHeldCash(riderId) {
  const oid = toOid(riderId);
  if (!oid) return { amount: 0, jobs: 0 };

  const [parcelRows] = await Promise.all([
    Parcel.aggregate([
      {
        $match: {
          deliveryPartnerId: oid,
          paymentMethod: "COD",
          "codSettlement.status": { $in: HELD_PARCEL_STATUSES },
        },
      },
      {
        $group: {
          _id: null,
          amount: { $sum: { $ifNull: ["$codSettlement.collectAmount", "$fare"] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    amount: round2(parcelRows[0]?.amount || 0),
    jobs: parcelRows[0]?.count || 0,
    outstationAmount: round2(parcelRows[0]?.amount || 0),
    localAmount: 0,
  };
}

/**
 * The whole picture for one rider: limit, held, remaining, and whether they
 * are blocked from taking work.
 *
 * This is the single source of truth for the gate. The rider app renders it,
 * the admin screen renders it, and the two job feeds enforce it — so what a
 * rider is told and what actually happens cannot disagree.
 */
export async function getRiderCashStatus(riderId, { settings = null, rider = null } = {}) {
  const oid = toOid(riderId);
  if (!oid) {
    return {
      limitEnforced: false,
      limit: 0,
      limitSource: "global",
      held: 0,
      heldJobs: 0,
      remaining: 0,
      usedPercent: 0,
      blocked: false,
      warning: false,
      pendingDepositAmount: 0,
      pendingDepositCount: 0,
      reason: "",
    };
  }

  const [config, riderDoc, held, pending] = await Promise.all([
    settings ? Promise.resolve(settings) : getPorterCashSettings(),
    rider
      ? Promise.resolve(rider)
      : Delivery.findById(oid).select("cashLimit name phone").lean(),
    getRiderHeldCash(oid),
    CashDeposit.aggregate([
      { $match: { riderId: oid, status: "PENDING" } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const hasOverride =
    riderDoc?.cashLimit !== null &&
    riderDoc?.cashLimit !== undefined &&
    Number.isFinite(Number(riderDoc.cashLimit));

  const limit = hasOverride ? round2(riderDoc.cashLimit) : round2(config.globalCashLimit);
  const remaining = round2(Math.max(0, limit - held.amount));
  const usedPercent = limit > 0 ? Math.min(100, Math.round((held.amount / limit) * 100)) : 100;

  const pendingAmount = round2(pending[0]?.amount || 0);
  const pendingCount = pending[0]?.count || 0;

  /**
   * A rider is blocked once held cash REACHES the limit, not once it passes
   * it. At exactly the limit they have no headroom for the next COD job, and
   * offering them one they cannot legally accept is worse than showing them
   * nothing.
   *
   * Under the default rule a pending deposit does NOT unblock them: deposit →
   * admin approval → work resumes, and approval is what moves the bookings to
   * REMITTED_TO_ADMIN, which is what actually lowers `held`.
   *
   * `requireApprovalToResume: false` is the looser stance for an operation
   * that trusts its riders — the deposit is already a captured gateway
   * payment, so the money is provably in the platform's account and only the
   * bookkeeping is outstanding. There it counts against the balance
   * immediately.
   */
  const effectiveHeld = config.requireApprovalToResume
    ? held.amount
    : round2(Math.max(0, held.amount - pendingAmount));

  const blocked = config.enforceCashLimit && effectiveHeld >= limit;
  const warning =
    config.enforceCashLimit && !blocked && usedPercent >= config.warnAtPercent;

  let reason = "";
  if (blocked) {
    reason = pendingCount
      ? `You are holding ₹${held.amount} in cash and your deposit of ₹${pendingAmount} is waiting for admin approval. New jobs resume once it is approved.`
      : `You are holding ₹${held.amount}, which is your full cash limit of ₹${limit}. Deposit the cash to start receiving jobs again.`;
  } else if (warning) {
    reason = `You are holding ₹${held.amount} of your ₹${limit} cash limit. Only ₹${remaining} left before new jobs stop.`;
  }

  return {
    limitEnforced: config.enforceCashLimit,
    limit,
    limitSource: hasOverride ? "rider" : "global",
    globalLimit: round2(config.globalCashLimit),
    held: held.amount,
    heldJobs: held.jobs,
    heldLocal: held.localAmount,
    heldOutstation: held.outstationAmount,
    remaining,
    usedPercent,
    warnAtPercent: config.warnAtPercent,
    blocked,
    warning,
    pendingDepositAmount: pendingAmount,
    pendingDepositCount: pendingCount,
    reason,
  };
}

/**
 * The gate, as one boolean plus a sentence.
 *
 * Called by both job feeds and both accept paths. Kept separate from
 * `getRiderCashStatus` so a hot path can read one small object, and so the
 * refusal message a rider sees is written in exactly one place.
 */
export async function assertRiderCanTakeJobs(riderId) {
  try {
    const status = await getRiderCashStatus(riderId);
    return {
      allowed: !status.blocked,
      status,
      message: status.reason,
    };
  } catch (error) {
    /**
     * Fails OPEN, deliberately.
     *
     * This gate sits in front of every job feed and every accept, for both
     * products. If the balance lookup breaks — a slow aggregation, a replica
     * that lags, an index dropped during a deploy — failing closed would stop
     * the entire fleet from working, everywhere, until someone noticed.
     * Failing open risks a rider briefly carrying more cash than their limit,
     * which the next successful check corrects.
     *
     * Between "no deliveries happen" and "one rider is ₹500 over for ten
     * minutes", the second is obviously the lesser harm.
     */
    logger.error("porter_cash_gate_failed_open", {
      riderId: String(riderId),
      message: error?.message,
    });
    return { allowed: true, status: null, message: "" };
  }
}

/**
 * Drop the riders who are at their limit from a broadcast list.
 *
 * The pull feed and the accept path both gate individually, but a PUSH has to
 * gate in bulk — a broadcast fans out to every rider in range at once, and
 * asking `getRiderCashStatus` per rider would be one aggregation per person
 * per broadcast round. This does the whole list in two group-bys.
 *
 * Buzzing a blocked rider's phone with a job they cannot accept is worse than
 * not reaching them: it teaches them to ignore the notification.
 */
export async function filterRidersWithCashHeadroom(riderIds = []) {
  const ids = [...new Set(riderIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  const settings = await getPorterCashSettings();
  if (!settings.enforceCashLimit) return ids;

  const oids = ids.map(toOid).filter(Boolean);

  const [riders, parcelRows, pendingRows] = await Promise.all([
    Delivery.find({ _id: { $in: oids } })
      .select("cashLimit")
      .lean(),
    Parcel.aggregate([
      {
        $match: {
          deliveryPartnerId: { $in: oids },
          paymentMethod: "COD",
          "codSettlement.status": { $in: HELD_PARCEL_STATUSES },
        },
      },
      {
        $group: {
          _id: "$deliveryPartnerId",
          amount: { $sum: { $ifNull: ["$codSettlement.collectAmount", "$fare"] } },
        },
      },
    ]),
    // Only needed under the looser rule, but fetched unconditionally: it is
    // one indexed group-by, and branching the Promise.all to save it would
    // cost more in readability than it saves in round trips.
    CashDeposit.aggregate([
      { $match: { riderId: { $in: oids }, status: "PENDING" } },
      { $group: { _id: "$riderId", amount: { $sum: "$amount" } } },
    ]),
  ]);

  const heldBy = new Map();
  parcelRows.forEach((row) => {
    const id = String(row._id);
    heldBy.set(id, (heldBy.get(id) || 0) + (row.amount || 0));
  });

  // Mirrors `getRiderCashStatus` exactly: a pending deposit only lowers the
  // balance when the operation has said an approval is not required first.
  if (!settings.requireApprovalToResume) {
    pendingRows.forEach((row) => {
      const id = String(row._id);
      heldBy.set(id, Math.max(0, (heldBy.get(id) || 0) - (row.amount || 0)));
    });
  }

  const limitBy = new Map(
    riders.map((rider) => {
      const hasOverride =
        rider.cashLimit !== null &&
        rider.cashLimit !== undefined &&
        Number.isFinite(Number(rider.cashLimit));
      return [String(rider._id), hasOverride ? Number(rider.cashLimit) : settings.globalCashLimit];
    }),
  );

  return ids.filter((id) => {
    // A rider the query did not return no longer exists; the caller's own
    // eligibility checks will drop them anyway, so do not block here.
    if (!limitBy.has(id)) return true;
    return (heldBy.get(id) || 0) < limitBy.get(id);
  });
}

/* ==========================================================================
   Fleet view
   ========================================================================== */

/**
 * Limit, held and remaining for every approved rider — the admin Cash
 * Collection screen.
 *
 * Built from the two booking collections in two aggregations and then joined
 * in memory, rather than a `$lookup` per rider. A fleet of a few hundred
 * riders against two indexed group-bys is one round trip each; the lookup
 * version was doing a full scan of `transactions` and `orders` for every
 * rider on every page load.
 */
export async function getFleetCashOverview({ search = "", page = 1, limit = 25 } = {}) {
  const settings = await getPorterCashSettings();

  const riderMatch = { isVerified: true };
  if (String(search || "").trim()) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    riderMatch.$or = [{ name: rx }, { phone: rx }];
  }

  const skip = (Math.max(1, page) - 1) * limit;

  const [riders, total, parcelRows, pendingRows] = await Promise.all([
    Delivery.find(riderMatch)
      .select("name phone profileImage vehicleType isOnline isActive cashLimit")
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Delivery.countDocuments(riderMatch),
    Parcel.aggregate([
      {
        $match: {
          paymentMethod: "COD",
          deliveryPartnerId: { $ne: null },
          "codSettlement.status": { $in: HELD_PARCEL_STATUSES },
        },
      },
      {
        $group: {
          _id: "$deliveryPartnerId",
          amount: { $sum: { $ifNull: ["$codSettlement.collectAmount", "$fare"] } },
          count: { $sum: 1 },
        },
      },
    ]),
    CashDeposit.aggregate([
      { $match: { status: "PENDING" } },
      { $group: { _id: "$riderId", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const heldBy = new Map();
  const bump = (rows, key) => {
    rows.forEach((row) => {
      const id = String(row._id);
      const current = heldBy.get(id) || { amount: 0, jobs: 0, local: 0, outstation: 0 };
      current.amount += row.amount || 0;
      current.jobs += row.count || 0;
      current[key] += row.amount || 0;
      heldBy.set(id, current);
    });
  };
  bump(parcelRows, "outstation");

  const pendingBy = new Map(
    pendingRows.map((row) => [String(row._id), { amount: row.amount || 0, count: row.count || 0 }]),
  );

  const items = riders.map((rider) => {
    const id = String(rider._id);
    const held = heldBy.get(id) || { amount: 0, jobs: 0, local: 0, outstation: 0 };
    const pending = pendingBy.get(id) || { amount: 0, count: 0 };

    const hasOverride =
      rider.cashLimit !== null &&
      rider.cashLimit !== undefined &&
      Number.isFinite(Number(rider.cashLimit));
    const riderLimit = hasOverride ? round2(rider.cashLimit) : round2(settings.globalCashLimit);
    const heldAmount = round2(held.amount);
    const remaining = round2(Math.max(0, riderLimit - heldAmount));
    const usedPercent =
      riderLimit > 0 ? Math.min(100, Math.round((heldAmount / riderLimit) * 100)) : 100;
    const blocked = settings.enforceCashLimit && heldAmount >= riderLimit;

    return {
      id,
      name: rider.name || "Rider",
      phone: rider.phone || "",
      avatar: rider.profileImage || "",
      vehicleType: rider.vehicleType || "",
      isOnline: Boolean(rider.isOnline),
      isActive: rider.isActive !== false,
      limit: riderLimit,
      limitSource: hasOverride ? "rider" : "global",
      /** Null renders as "using the global limit" in the admin table. */
      riderLimitOverride: hasOverride ? round2(rider.cashLimit) : null,
      currentCash: heldAmount,
      localCash: round2(held.local),
      outstationCash: round2(held.outstation),
      heldJobs: held.jobs,
      remaining,
      usedPercent,
      blocked,
      pendingDepositAmount: round2(pending.amount),
      pendingDepositCount: pending.count,
      status: blocked ? "blocked" : usedPercent >= settings.warnAtPercent ? "warning" : "safe",
    };
  });

  const totals = items.reduce(
    (acc, item) => {
      acc.totalInHand += item.currentCash;
      acc.totalLimit += item.limit;
      if (item.blocked) acc.blockedCount += 1;
      if (item.pendingDepositCount) acc.pendingDeposits += item.pendingDepositCount;
      acc.pendingDepositAmount += item.pendingDepositAmount;
      return acc;
    },
    { totalInHand: 0, totalLimit: 0, blockedCount: 0, pendingDeposits: 0, pendingDepositAmount: 0 },
  );

  return {
    items,
    page: Math.max(1, page),
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    settings,
    stats: {
      totalInHand: round2(totals.totalInHand),
      totalLimit: round2(totals.totalLimit),
      blockedCount: totals.blockedCount,
      pendingDeposits: totals.pendingDeposits,
      pendingDepositAmount: round2(totals.pendingDepositAmount),
      avgBalance: items.length ? round2(totals.totalInHand / items.length) : 0,
    },
  };
}
