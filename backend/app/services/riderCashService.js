import mongoose from "mongoose";
import CashDeposit from "../models/cashDeposit.js";
import Parcel from "../models/parcel.js";
import Delivery from "../models/delivery.js";
import Notification from "../models/notification.js";
import Transaction from "../models/transaction.js";
import Setting from "../models/setting.js";
import { emitToDelivery } from "./orderSocketEmitter.js";

/**
 * Porter COD cash: what a rider is holding, and how it gets back to admin.
 *
 * The rule this service enforces is that nothing clears itself. A rider
 * collects cash at pickup, the booking sits at RIDER_HOLDING, and it only
 * leaves that state when an admin approves a deposit that names it. There is
 * deliberately no rider-side "mark as paid" — the proof image and the admin
 * review are the entire point.
 *
 * `WITH_SELLER` is treated as rider-held here on purpose. The old outstation
 * flow stamped every COD parcel WITH_SELLER on hub drop-off, including the
 * ones with `sellerId: null` (which is all of them now that the business runs
 * on warehouses). No seller could ever confirm those, so the cash was stuck
 * with the rider in reality while the document claimed otherwise. Counting
 * that state as held is what un-sticks the existing backlog.
 */

const HELD_PARCEL_STATUSES = ["RIDER_HOLDING", "WITH_SELLER"];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/** COD amount a booking is holding, falling back to the fare. */
const parcelHeldAmount = (doc) =>
  round2(Number(doc?.codSettlement?.collectAmount) || Number(doc?.fare) || 0);

/**
 * Bookings already named by a deposit that is still awaiting review — they
 * must not be offered again, or two pending deposits could claim one job.
 */
async function getLockedRefIds(riderId) {
  const pending = await CashDeposit.find({ riderId, status: "PENDING" })
    .select("items.refId")
    .lean();

  const locked = new Set();
  pending.forEach((deposit) => {
    (deposit.items || []).forEach((item) => locked.add(String(item.refId)));
  });
  return locked;
}

/**
 * Every COD job whose cash is physically with this rider, plus the totals the
 * rider and admin screens show.
 */
export async function getRiderCodSummary(riderId) {
  const riderObjectId = toObjectId(riderId);

  const [parcels, locked, pendingDeposits] = await Promise.all([
    Parcel.find({
      deliveryPartnerId: riderObjectId,
      paymentMethod: "COD",
      "codSettlement.status": { $in: HELD_PARCEL_STATUSES },
    })
      .select("fare codSettlement status createdAt destinationCity courierCompany")
      .sort({ createdAt: 1 })
      .lean(),
    getLockedRefIds(riderObjectId),
    CashDeposit.find({ riderId: riderObjectId, status: "PENDING" })
      .select("amount createdAt")
      .lean(),
  ]);

  const items = [
    ...parcels.map((doc) => ({
      kind: "parcel",
      refId: String(doc._id),
      label: `Courier · ${String(doc._id).slice(-6).toUpperCase()}`,
      amount: parcelHeldAmount(doc),
      collectedAt: doc.codSettlement?.riderCollectedAt || doc.createdAt,
      status: doc.status,
    })),
  ].sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));

  const available = items.filter((item) => !locked.has(item.refId));
  const awaitingReview = items.filter((item) => locked.has(item.refId));

  return {
    items: available,
    depositableAmount: round2(available.reduce((sum, i) => sum + i.amount, 0)),
    awaitingReviewAmount: round2(awaitingReview.reduce((sum, i) => sum + i.amount, 0)),
    pendingDepositCount: pendingDeposits.length,
    totalHeld: round2(items.reduce((sum, i) => sum + i.amount, 0)),
  };
}

/**
 * Raise a deposit request.
 *
 * The amount is never taken from the client — it is summed from the jobs the
 * rider actually holds, so a request can't claim more than was collected.
 * `selection` is optional; without it the whole held balance is deposited.
 */
export async function createCashDeposit({
  riderId,
  method,
  reference = "",
  proofImageUrl = "",
  note = "",
  selection = null,
}) {
  const summary = await getRiderCodSummary(riderId);

  if (!summary.items.length) {
    const err = new Error("You have no collected cash to deposit right now");
    err.statusCode = 400;
    throw err;
  }

  let chosen = summary.items;
  if (Array.isArray(selection) && selection.length) {
    const wanted = new Set(selection.map((s) => String(s.refId || s)));
    chosen = summary.items.filter((item) => wanted.has(item.refId));
    if (!chosen.length) {
      const err = new Error("None of the selected bookings are available to deposit");
      err.statusCode = 400;
      throw err;
    }
  }

  const amount = round2(chosen.reduce((sum, item) => sum + item.amount, 0));
  if (!(amount > 0)) {
    const err = new Error("Nothing to deposit");
    err.statusCode = 400;
    throw err;
  }

  // Electronic transfers must be traceable; a cash handover at the office
  // cannot be, which is exactly why it still needs an admin to approve it.
  if (method !== "CASH" && !String(reference).trim() && !String(proofImageUrl).trim()) {
    const err = new Error("Add the transaction reference or a payment screenshot");
    err.statusCode = 400;
    throw err;
  }

  const deposit = await CashDeposit.create({
    riderId: toObjectId(riderId),
    amount,
    method,
    reference: String(reference).trim(),
    proofImageUrl: String(proofImageUrl).trim(),
    note: String(note).trim(),
    items: chosen.map((item) => ({
      kind: item.kind,
      refId: toObjectId(item.refId),
      amount: item.amount,
      label: item.label,
    })),
    status: "PENDING",
  });

  return deposit.toObject();
}

/**
 * Move every booking a deposit names into REMITTED_TO_ADMIN.
 *
 * Scoped by the same held-statuses the request was built from, so a booking
 * that was settled another way in the meantime is skipped rather than
 * double-counted.
 */
async function markItemsRemitted(items) {
  const now = new Date();
  const parcelIds = items.filter((i) => i.kind === "parcel").map((i) => i.refId);

  const parcelResult = parcelIds.length
    ? await Parcel.updateMany(
        { _id: { $in: parcelIds }, "codSettlement.status": { $in: HELD_PARCEL_STATUSES } },
        {
          $set: {
            "codSettlement.status": "REMITTED_TO_ADMIN",
            "codSettlement.remittedAt": now,
            paymentStatus: "PAID",
          },
        },
      )
    : { modifiedCount: 0 };

  return {
    parcelsRemitted: parcelResult.modifiedCount || 0,
  };
}

/**
 * Settle a deposit: remit the bookings it names, mirror the legacy ledger,
 * flip its status, and notify the rider. Shared by the admin's manual
 * approve (legacy CASH/UPI/BANK_TRANSFER deposits, which have no automatic
 * proof of a real handover) and the automatic settle for ONLINE deposits
 * (where a verified Razorpay capture already IS the proof — see
 * autoSettleOnlineDeposit in porter/riderDepositService.js).
 */
async function finalizeCashDeposit(deposit, { approve, adminId = null, adminNote = "" }) {
  let remitted = { parcelsRemitted: 0 };
  if (approve) {
    remitted = await markItemsRemitted(deposit.items || []);

    // Mirror the settlement onto the legacy cash ledger the admin Cash
    // Collection Hub reads, so porter cash nets off there too rather than
    // showing as permanently outstanding.
    await Transaction.findOneAndUpdate(
      { reference: `CSH-DEP-${String(deposit._id)}` },
      {
        $set: {
          amount: -Math.abs(deposit.amount),
          status: "Settled",
          meta: {
            source: "porter_cash_deposit",
            depositId: String(deposit._id),
            method: deposit.method,
          },
        },
        $setOnInsert: {
          user: deposit.riderId,
          userModel: "Delivery",
          type: "Cash Settlement",
          reference: `CSH-DEP-${String(deposit._id)}`,
          date: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }

  deposit.status = approve ? "APPROVED" : "REJECTED";
  deposit.reviewedBy = adminId ? toObjectId(adminId) : null;
  deposit.reviewedAt = new Date();
  deposit.adminNote = String(adminNote || "").trim();
  await deposit.save();

  /**
   * The rider's cash status after the decision.
   *
   * Approving is what actually lowers what they are holding, so it is also
   * what lifts the cash-limit block — and a rider whose jobs stopped needs to
   * be TOLD they have started again, not left refreshing an empty feed. The
   * status is read after the remit above so it reflects the new balance.
   */
  const { getRiderCashStatus } = await import("./porter/riderCashLimitService.js");
  const cashStatus = await getRiderCashStatus(deposit.riderId).catch(() => null);
  const unblocked = approve && cashStatus && !cashStatus.blocked;

  await Notification.create({
    recipient: deposit.riderId,
    recipientModel: "Delivery",
    title: approve ? "Cash deposit approved" : "Cash deposit rejected",
    message: approve
      ? `Your ₹${deposit.amount} cash deposit has been verified and cleared.${
          unblocked ? " You can take new jobs again." : ""
        }`
      : `Your ₹${deposit.amount} cash deposit was rejected.${
          deposit.adminNote ? ` Reason: ${deposit.adminNote}` : ""
        }`,
    type: "payment",
    data: { depositId: String(deposit._id) },
  }).catch(() => {
    /* a notification failure must not undo a settled deposit */
  });

  // Live update for an app that is already open, so the meter and the job
  // feed both refresh without waiting for the next poll.
  emitToDelivery(String(deposit.riderId), "porter:cash:status", {
    depositId: String(deposit._id),
    status: deposit.status,
    cashStatus,
  });

  return { deposit: deposit.toObject(), cashStatus, ...remitted };
}

/**
 * Admin decision on a deposit. Approving is what actually clears the cash;
 * rejecting leaves every booking held so the rider can raise a new request.
 *
 * Only reached for legacy CASH/UPI/BANK_TRANSFER/OTHER deposits now — an
 * ONLINE deposit settles itself the moment its Razorpay payment is verified
 * (see autoSettleOnlineDeposit) and is never left PENDING for admin review.
 */
export async function reviewCashDeposit({ depositId, adminId, approve, adminNote = "" }) {
  if (!mongoose.Types.ObjectId.isValid(depositId)) return null;

  const deposit = await CashDeposit.findById(depositId);
  if (!deposit) return null;

  // An ONLINE deposit auto-settles on payment verify and should never reach
  // here PENDING; if one somehow does, refuse rather than let an admin
  // double-remit bookings that verification already settled.
  if (deposit.method === "ONLINE") {
    const err = new Error("Online deposits settle automatically and do not need admin review");
    err.statusCode = 409;
    throw err;
  }

  if (deposit.status !== "PENDING") {
    const err = new Error(`This deposit is already ${deposit.status.toLowerCase()}`);
    err.statusCode = 409;
    throw err;
  }

  return finalizeCashDeposit(deposit, { approve, adminId, adminNote });
}

/**
 * Auto-settle an ONLINE deposit right after its Razorpay payment is
 * verified. No admin step: the cryptographic signature check plus the
 * server-to-gateway status read (see verifyRiderDepositReceipt) already
 * prove the money was captured, so a manual "approve" here would just be
 * re-confirming something the platform itself already confirmed.
 */
export async function autoSettleOnlineDeposit(deposit) {
  return finalizeCashDeposit(deposit, {
    approve: true,
    adminId: null,
    adminNote: "Auto-settled — verified online payment",
  });
}

/** Deposit list for both the admin queue and the rider's own history. */
export async function listCashDeposits({
  status = "all",
  riderId = null,
  page = 1,
  limit = 25,
  skip = 0,
}) {
  const match = {};
  if (["PENDING", "APPROVED", "REJECTED"].includes(String(status).toUpperCase())) {
    match.status = String(status).toUpperCase();
  }
  if (riderId) match.riderId = toObjectId(riderId);

  const [rows, total, pendingTotals] = await Promise.all([
    CashDeposit.find(match)
      .populate("riderId", "name phone vehicleType upiId accountHolder accountNumber ifsc bankName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CashDeposit.countDocuments(match),
    // Scoped to the same rider when one is given, so the rider app shows
    // their own pending total and the admin queue shows the fleet-wide one.
    CashDeposit.aggregate([
      { $match: { status: "PENDING", ...(riderId ? { riderId: toObjectId(riderId) } : {}) } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    items: rows.map((row) => ({
      id: String(row._id),
      rider: row.riderId?.name || "Rider",
      riderId: String(row.riderId?._id || row.riderId || ""),
      riderPhone: row.riderId?.phone || "",
      amount: round2(row.amount),
      method: row.method,
      reference: row.reference,
      proofImageUrl: row.proofImageUrl,
      note: row.note,
      status: row.status,
      items: (row.items || []).map((item) => ({
        kind: item.kind,
        refId: String(item.refId),
        amount: round2(item.amount),
        label: item.label,
      })),
      adminNote: row.adminNote,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    pending: {
      amount: round2(pendingTotals[0]?.amount || 0),
      count: pendingTotals[0]?.count || 0,
    },
  };
}

/**
 * Cash a rider is holding across every rider — the admin's "who owes us
 * money" view, built from the bookings themselves rather than the legacy
 * Transaction ledger that never knew about porter.
 */
export async function getFleetCashHoldings() {
  const parcelRows = await Parcel.aggregate([
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
  ]);

  const byRider = new Map();
  parcelRows.forEach((row) => {
    const key = String(row._id);
    const existing = byRider.get(key) || { amount: 0, count: 0 };
    byRider.set(key, {
      amount: existing.amount + (row.amount || 0),
      count: existing.count + (row.count || 0),
    });
  });

  if (!byRider.size) {
    return { items: [], totalHeld: 0 };
  }

  const riders = await Delivery.find({ _id: { $in: [...byRider.keys()].map(toObjectId) } })
    .select("name phone vehicleType isOnline")
    .lean();
  const riderMap = new Map(riders.map((r) => [String(r._id), r]));

  const items = [...byRider.entries()]
    .map(([riderId, totals]) => ({
      riderId,
      name: riderMap.get(riderId)?.name || "Rider",
      phone: riderMap.get(riderId)?.phone || "",
      isOnline: Boolean(riderMap.get(riderId)?.isOnline),
      heldAmount: round2(totals.amount),
      heldJobs: totals.count,
    }))
    .sort((a, b) => b.heldAmount - a.heldAmount);

  return {
    items,
    totalHeld: round2(items.reduce((sum, i) => sum + i.heldAmount, 0)),
  };
}

/**
 * Records that a rider took cash for a booking, on the legacy ledger the
 * admin cash screens read. Upserted on a deterministic reference so a
 * repeated status call cannot double-count the same job.
 */
export async function recordCodCollection({ riderId, kind, refId, amount }) {
  const value = round2(amount);
  if (!riderId || !(value > 0)) return null;

  const prefix = "CASH-COL-PCL";
  return Transaction.findOneAndUpdate(
    { reference: `${prefix}-${String(refId)}` },
    {
      $set: {
        amount: value,
        status: "Settled",
        meta: { source: "porter_cod_collection", kind, refId: String(refId) },
      },
      $setOnInsert: {
        user: toObjectId(riderId),
        userModel: "Delivery",
        type: "Cash Collection",
        reference: `${prefix}-${String(refId)}`,
        date: new Date(),
      },
    },
    { upsert: true, new: true },
  ).catch(() => null);
}

/* ==========================================================================
   Where the rider actually sends the cash
   ========================================================================== */

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_PATTERN = /^[\w.\-]{2,60}@[a-zA-Z]{2,20}$/;

const emptyPayoutDestination = () => ({
  upiId: "",
  qrImageUrl: "",
  bankAccountHolder: "",
  bankAccountNumber: "",
  bankIfsc: "",
  bankName: "",
});

/**
 * What admin has configured as the deposit destination.
 *
 * Read by both the admin panel (to prefill the edit form) and the rider app
 * (read-only, so a rider always sees the live value, never a stale copy).
 */
export async function getCashPayoutDestination() {
  const setting = await Setting.findOne({}).select("cashDepositPayout").lean();
  return { ...emptyPayoutDestination(), ...(setting?.cashDepositPayout || {}) };
}

/**
 * Admin sets where deposits should go. Validated the same way rider payout
 * details are (see deliveryAuthController.updateDeliveryPayoutDetails) — a
 * half-typed bank account is worse than none, because a rider would transfer
 * into it and the money would simply fail to land.
 */
export async function updateCashPayoutDestination(patch = {}) {
  const next = { ...(await getCashPayoutDestination()) };

  if (patch.upiId !== undefined) {
    const upi = String(patch.upiId).trim();
    if (upi && !UPI_PATTERN.test(upi)) {
      const err = new Error("Enter a valid UPI ID (e.g. admin@bank)");
      err.statusCode = 400;
      throw err;
    }
    next.upiId = upi;
  }
  if (patch.qrImageUrl !== undefined) next.qrImageUrl = String(patch.qrImageUrl).trim();
  if (patch.bankAccountHolder !== undefined) {
    next.bankAccountHolder = String(patch.bankAccountHolder).trim();
  }
  if (patch.bankName !== undefined) next.bankName = String(patch.bankName).trim();
  if (patch.bankAccountNumber !== undefined) {
    const digits = String(patch.bankAccountNumber).replace(/\s/g, "");
    if (digits && !/^\d{9,18}$/.test(digits)) {
      const err = new Error("Account number must be 9 to 18 digits");
      err.statusCode = 400;
      throw err;
    }
    next.bankAccountNumber = digits;
  }
  if (patch.bankIfsc !== undefined) {
    const code = String(patch.bankIfsc).trim().toUpperCase();
    if (code && !IFSC_PATTERN.test(code)) {
      const err = new Error("Enter a valid IFSC code (e.g. HDFC0001234)");
      err.statusCode = 400;
      throw err;
    }
    next.bankIfsc = code;
  }

  const hasBank = Boolean(next.bankAccountHolder && next.bankAccountNumber && next.bankIfsc);
  if (next.bankAccountNumber && !hasBank) {
    const err = new Error("A bank account needs the holder name and IFSC too");
    err.statusCode = 400;
    throw err;
  }

  // An empty save would silently blank out whatever was configured — the
  // rider deposit form would go back to showing "no destination set" with no
  // warning. Require at least one live method before it is allowed through.
  if (!next.upiId && !next.qrImageUrl && !hasBank) {
    const err = new Error("Add at least a UPI ID, a QR image, or a bank account");
    err.statusCode = 400;
    throw err;
  }

  const setting = await Setting.findOneAndUpdate(
    {},
    { $set: { cashDepositPayout: next } },
    { new: true, upsert: true },
  ).lean();

  return setting.cashDepositPayout;
}
