import Transaction from "../models/transaction.js";
import ParcelConfig from "../models/parcelConfig.js";
import { computeRiderParcelEarnings } from "./parcelWorkflowService.js";
import { buildKey, invalidate } from "./cacheService.js";
import { roundCurrency } from "../utils/money.js";

/**
 * Credit delivery partner earnings when a parcel is delivered to the hub.
 * Uses legacy Transaction rows so Earnings / Dashboard pages update.
 */
export async function applyParcelDeliveredRiderEarning(parcel) {
  const riderId = parcel?.deliveryPartnerId?._id || parcel?.deliveryPartnerId;
  if (!riderId || !parcel?._id) return null;

  const settings = await ParcelConfig.getSearchSettings();
  // Rider pay is always distance × riderPerKmRate — the distance from where
  // the rider stood when they accepted (riderAcceptLocation) to the pickup
  // point. No flat-percent-of-fare fallback: a parcel with no accept-location
  // snapshot (e.g. admin-assigned with no rider GPS fix) earns 0 here rather
  // than a flat share of the fare.
  const amount = roundCurrency(computeRiderParcelEarnings(parcel, settings));
  if (!(amount > 0)) return null;

  const parcelId = String(parcel._id);
  const reference = `PCL-ERN-${parcelId}`;
  const breakdown = parcel.fareBreakdown || {};

  const txn = await Transaction.findOneAndUpdate(
    { reference },
    {
      $set: {
        amount,
        status: "Settled",
        meta: {
          kind: "parcel",
          parcelId,
          payoutBase: roundCurrency(breakdown.baseFare || 0),
          payoutDistance: roundCurrency(breakdown.distanceFare || 0),
          deliverySpeed: parcel.deliverySpeed || "normal",
          paymentMethod: parcel.paymentMethod || "",
        },
      },
      $setOnInsert: {
        user: riderId,
        userModel: "Delivery",
        type: "Delivery Earning",
        reference,
        date: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  await Promise.all([
    invalidate(buildKey("delivery", "earnings", String(riderId))),
    invalidate(buildKey("delivery", "stats", String(riderId))),
  ]).catch(() => {});

  return txn;
}

/**
 * The actual amount credited for each delivered parcel — what settled onto
 * the rider's ledger, not a fresh recompute.
 *
 * A delivered parcel's earning must never be recomputed live: it was frozen
 * at whatever `computeRiderParcelEarnings`/the legacy fallback produced at
 * delivery time (see applyParcelDeliveredRiderEarning above), and that is the
 * amount already sitting in the rider's wallet. If a screen instead
 * recomputes it fresh using the CURRENT `riderPerKmRate`, an admin changing
 * that rate after the fact silently rewrites what every past delivery
 * appears to have earned — the "Your Earning" shown per order and the real
 * "Delivery Earning" transaction in Recent Earnings then disagree.
 *
 * @returns {Map<string, number>} parcelId (string) -> settled amount
 */
export async function getSettledParcelEarnings(parcelIds = []) {
  const ids = [...new Set(parcelIds.map(String))].filter(Boolean);
  if (!ids.length) return new Map();

  const rows = await Transaction.find({
    reference: { $in: ids.map((id) => `PCL-ERN-${id}`) },
    type: "Delivery Earning",
  })
    .select("reference amount")
    .lean();

  const map = new Map();
  for (const row of rows) {
    const parcelId = String(row.reference).replace(/^PCL-ERN-/, "");
    map.set(parcelId, roundCurrency(row.amount));
  }
  return map;
}

/**
 * Ensure every delivered parcel for this rider has a Settled earning transaction.
 * Fixes past deliveries that completed before settlement was wired.
 */
export async function backfillMissingParcelEarnings(deliveryBoyId) {
  const Parcel = (await import("../models/parcel.js")).default;
  const parcels = await Parcel.find({
    deliveryPartnerId: deliveryBoyId,
    status: "DELIVERED",
  })
    .select("_id fare fareBreakdown deliveryPartnerId deliverySpeed paymentMethod")
    .lean();

  if (!parcels.length) return 0;

  const refs = parcels.map((p) => `PCL-ERN-${String(p._id)}`);
  const existing = await Transaction.find({ reference: { $in: refs } })
    .select("reference")
    .lean();
  const existingSet = new Set(existing.map((t) => t.reference));

  let created = 0;
  for (const parcel of parcels) {
    const reference = `PCL-ERN-${String(parcel._id)}`;
    if (existingSet.has(reference)) continue;
    await applyParcelDeliveredRiderEarning(parcel);
    created += 1;
  }
  return created;
}
