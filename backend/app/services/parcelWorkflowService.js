import mongoose from "mongoose";
import Parcel from "../models/parcel.js";
import ParcelConfig from "../models/parcelConfig.js";
import Delivery from "../models/delivery.js";
import { distanceMeters } from "../utils/geoUtils.js";
import { getParcelRidersNearPickupSortedByDistance } from "./deliveryNearbyService.js";
import { getActiveZoneById, isPointInZoneId } from "./deliveryZoneService.js";
import {
  emitParcelBroadcast,
  retractParcelBroadcast,
  emitToDelivery,
  emitToCustomer,
  emitToAdmins,
  emitToSeller,
} from "./orderSocketEmitter.js";
import { findNearestParcelSellerNearPickup, getApprovedParcelSeller } from "./sellerNearbyService.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { getRedisClient } from "../config/redis.js";
import {
  deliveryPartnerHasActiveJob,
  markDeliveryPartnerBusy,
} from "./deliveryBusyService.js";
import { recordParcelEvent, PARCEL_EVENT_ACTOR } from "./parcelEventService.js";
import { assertRiderCanTakeJobs } from "./porter/riderCashLimitService.js";

async function assertRiderWithinPickupRadius(deliveryOid, parcelId) {
  const [rider, parcel, settings] = await Promise.all([
    Delivery.findById(deliveryOid).select("location zoneIds").lean(),
    Parcel.findById(parcelId).select("pickupAddress zoneId").lean(),
    ParcelConfig.getSearchSettings(),
  ]);

  const pickupLat = Number(parcel?.pickupAddress?.lat);
  const pickupLng = Number(parcel?.pickupAddress?.lng);
  const coords = rider?.location?.coordinates;

  if (
    !parcel ||
    !Array.isArray(coords) ||
    coords.length < 2 ||
    !Number.isFinite(pickupLat) ||
    !Number.isFinite(pickupLng)
  ) {
    const err = new Error("Pickup or rider location is unavailable");
    err.statusCode = 400;
    throw err;
  }

  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const err = new Error("Rider location is unavailable");
    err.statusCode = 400;
    throw err;
  }

  /**
   * Checked on the claim as well as on the broadcast/feed — a rider holding
   * an id from an earlier round, or one who has since ridden out of their
   * zone, could otherwise still take a job the push never should have let
   * them see. An assigned rider is judged against their assignment, not
   * their GPS; an unassigned one (legacy, or none configured) falls back to
   * physically standing in the job's zone.
   */
  if (parcel.zoneId) {
    const assignedZoneIds = (rider.zoneIds || []).map(String);
    const inZone = assignedZoneIds.length
      ? assignedZoneIds.includes(String(parcel.zoneId))
      : await isPointInZoneId(parcel.zoneId, lat, lng);

    if (!inZone) {
      const err = new Error(
        assignedZoneIds.length
          ? "This delivery is outside the zone you are assigned to."
          : "This delivery is reserved for riders inside its delivery zone.",
      );
      err.statusCode = 403;
      throw err;
    }
  }

  const radiusKm = settings.deliveryRadiusKm;
  if (distanceMeters(pickupLat, pickupLng, lat, lng) > radiusKm * 1000) {
    const err = new Error(
      `You must be within ${radiusKm} km of the pickup location to accept this courier`,
    );
    err.statusCode = 403;
    throw err;
  }
}

/**
 * How long one rider holds an offer before it moves to the next-nearest —
 * the sequential dispatch flow offers riders one at a time within the
 * admin's configured radius (nearest first), never all of them at once.
 * Deliberately its own env var rather than reusing the old
 * PARCEL_SEARCH_TIMEOUT_MS/PARCEL_SEARCH_MAX_ATTEMPTS pair (a broadcast-to-
 * everyone round timeout): a deployment that had tuned those for "how long
 * before retrying the whole radius" would get a very different, much longer
 * total search time if that same number were silently reinterpreted as
 * "how long before the next rider" and multiplied by however many riders
 * are in range.
 */
const PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS = () =>
  parseInt(process.env.PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS || "30000", 10);

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Rider payout = distance from where the rider stood when they accepted the
 * job to the pickup point, at the admin's configured per-km rate.
 *
 * Deliberately not a share of the fare: the fare is now a flat delivery
 * charge with no distance component (see utils/parcelFare.js), and what the
 * rider actually did — the pickup leg — has nothing to do with what the
 * courier drop is priced at. `riderAcceptLocation` is a one-time GPS snapshot
 * taken in riderAcceptParcel; a parcel that never accepted (still SEARCHING,
 * or a legacy row from before this field existed) has none, and this
 * degrades to 0 rather than throwing — a rider preview or a report should
 * never crash because one field is missing.
 */
/**
 * Same as computeRiderParcelEarnings, but returns the numbers that made up
 * the amount — the distance covered and the rate applied — not just the
 * total. This is what the rider app and the admin's per-parcel breakdown
 * both read, so "why did I earn ₹20" always has a literal answer: 4 km × ₹5.
 */
export function computeRiderParcelEarningBreakdown(parcel, settingsOrRate = {}) {
  const riderPerKmRate =
    typeof settingsOrRate === "number"
      ? Math.max(0, settingsOrRate)
      : Math.max(0, Number(settingsOrRate?.riderPerKmRate) || 0);

  const accept = parcel?.riderAcceptLocation;
  const pickup = parcel?.pickupAddress;
  const acceptLat = Number(accept?.lat);
  const acceptLng = Number(accept?.lng);
  const pickupLat = Number(pickup?.lat);
  const pickupLng = Number(pickup?.lng);

  if (
    !Number.isFinite(acceptLat) ||
    !Number.isFinite(acceptLng) ||
    !Number.isFinite(pickupLat) ||
    !Number.isFinite(pickupLng)
  ) {
    return { earning: 0, distanceKm: 0, ratePerKm: riderPerKmRate };
  }

  // Full precision for the money math; only the *displayed* km is rounded,
  // so "4.37 km × ₹5" on screen still adds up to the exact ₹ figure charged.
  const rawDistanceKm = distanceMeters(acceptLat, acceptLng, pickupLat, pickupLng) / 1000;
  return {
    earning: money(rawDistanceKm * riderPerKmRate),
    distanceKm: Math.round(rawDistanceKm * 100) / 100,
    ratePerKm: riderPerKmRate,
  };
}

export function computeRiderParcelEarnings(parcel, settingsOrRate = {}) {
  return computeRiderParcelEarningBreakdown(parcel, settingsOrRate).earning;
}

const timeoutTimers = new Map();

function toDeliveryObjectId(deliveryId) {
  if (!deliveryId) return null;
  const id = String(deliveryId);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

export function parcelBroadcastPayloadFromDoc(parcel, extra = {}, settings = {}) {
  const pickup = parcel.pickupAddress?.fullAddress || "Pickup location";
  const drop = parcel.dropAddress?.fullAddress || "Drop location";
  const fare = Number(parcel.fare) || 0;
  // No riderAcceptLocation yet at broadcast time — the rider has not
  // accepted, so the real payout distance is unknown until they do. The
  // preview earning is 0 here by construction (see computeRiderParcelEarnings).
  const earnings = computeRiderParcelEarnings(parcel, settings);
  const paymentMethod = String(parcel.paymentMethod || "COD").toUpperCase();
  const isCod = paymentMethod === "COD";
  const collectAmount = isCod
    ? Math.max(
        0,
        Number(parcel.codSettlement?.collectAmount) || Number(parcel.fare) || 0,
      )
    : 0;
  return {
    parcelId: parcel._id?.toString?.() || String(parcel._id),
    // Short code shown to riders, same format as the history list (PCL-XXXXXX).
    displayId: `PCL-${String(parcel._id).slice(-6).toUpperCase()}`,
    status: parcel.status,
    preview: {
      pickup,
      drop,
      fare,
      earnings,
      riderPerKmRate: settings.riderPerKmRate,
      weight: parcel.weight,
      distance: parcel.distance,
      deliverySpeed: parcel.deliverySpeed === "express" ? "express" : "normal",
      paymentMethod,
      collectAmount,
      type: "PARCEL",
      parcelType: parcel.parcelType || "outstation",
      courierCompanyId: parcel.courierCompanyId || null,
    },
    searchExpiresAt: parcel.searchExpiresAt,
    ...extra,
  };
}

function clearParcelSearchTimeout(parcelId) {
  const id = String(parcelId);
  const timer = timeoutTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(id);
  }
}

function scheduleParcelSearchTimeout(parcelId) {
  clearParcelSearchTimeout(parcelId);
  const delay = PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS();
  const timer = setTimeout(() => {
    processParcelSearchTimeout(parcelId).catch((err) => {
      console.warn("[parcelWorkflow] timeout failed", parcelId, err.message);
    });
  }, delay);
  timeoutTimers.set(String(parcelId), timer);
}

/**
 * No one left to offer within the configured radius (or the ones left can't
 * take the job right now) — hands off to manual admin assignment. The only
 * place this parcel falls out of the sequential offer loop short of someone
 * accepting.
 */
async function fallBackToManualAssignment(parcelId, customerId) {
  await retractParcelBroadcast(String(parcelId), null);

  await Parcel.findOneAndUpdate(
    { _id: parcelId, status: "SEARCHING" },
    {
      $set: { status: "REQUESTED" },
      $unset: { searchExpiresAt: 1, searchMeta: 1 },
    },
  );
  clearParcelSearchTimeout(parcelId);

  await recordParcelEvent({
    parcelId,
    status: "REQUESTED",
    previousStatus: "SEARCHING",
    actor: PARCEL_EVENT_ACTOR.SYSTEM,
    note: "No delivery partner accepted — needs manual assignment",
  });

  emitToAdmins("parcel:status:update", {
    _id: String(parcelId),
    status: "REQUESTED",
  });

  emitToCustomer(customerId, {
    event: "parcel:status:update",
    payload: {
      parcelId: String(parcelId),
      status: "REQUESTED",
      message: "No rider accepted in time. Admin will assign a rider shortly.",
    },
  });
}

/**
 * The sequential dispatch step: offer this parcel to exactly one rider — the
 * nearest one inside the admin's configured radius who hasn't already been
 * tried (rejected or timed out) for it — rather than everyone in range at
 * once. Called on the parcel's first search, and again every time the
 * currently-offered rider rejects or times out.
 *
 * Re-queries nearest-first each time instead of freezing an order up front,
 * so a rider going online/offline or moving in the meantime is reflected on
 * the very next pick, not just the first one.
 */
export async function offerParcelToNextRider(parcelId) {
  const parcel = await Parcel.findById(parcelId);
  if (!parcel || parcel.status !== "SEARCHING" || parcel.deliveryPartnerId) return;

  const lat = Number(parcel.pickupAddress?.lat);
  const lng = Number(parcel.pickupAddress?.lng);
  const settings = await ParcelConfig.getSearchSettings();
  const radiusKm = settings.deliveryRadiusKm;
  // Null for a parcel with no zone (unzoned install, or booked before zones
  // existed) — the lookup below then keeps the old, unzoned reach.
  const zone = await getActiveZoneById(parcel.zoneId);

  const sorted = await getParcelRidersNearPickupSortedByDistance(lat, lng, radiusKm, {
    zone,
    excludeIds: [...(parcel.skippedBy || []), ...(parcel.offerTimeoutBy || [])],
  });

  // Cash-gate up front, not just inside emitParcelBroadcast: skipping a
  // rider who can't take the job right now at pick time means the next
  // nearest one gets offered immediately, instead of burning a full
  // PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS window on someone who was never
  // going to be able to accept.
  const { filterRidersWithCashHeadroom } = await import(
    "./porter/riderCashLimitService.js"
  );
  const eligibleIds = new Set(
    await filterRidersWithCashHeadroom(sorted.map((r) => r.id)),
  );
  const next = sorted.find((r) => eligibleIds.has(r.id));

  if (!next) {
    await fallBackToManualAssignment(parcelId, parcel.customerId);
    return;
  }

  const now = new Date();
  const searchExpiresAt = new Date(now.getTime() + PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS());
  const nextAttempt = (parcel.searchMeta?.attempt || 0) + 1;

  const updated = await Parcel.findOneAndUpdate(
    { _id: parcelId, status: "SEARCHING", deliveryPartnerId: null },
    {
      $set: {
        searchExpiresAt,
        searchMeta: {
          radiusKm,
          attempt: nextAttempt,
          lastBroadcastAt: now,
          offeredTo: next.id,
          offeredAt: now,
        },
      },
    },
    { new: true },
  );

  if (!updated) return;

  await emitParcelBroadcast(
    lat,
    lng,
    radiusKm,
    parcelBroadcastPayloadFromDoc(updated, {}, settings),
    { zone, riderIds: [next.id] },
  );

  emitToAdmins("parcel:status:update", updated);
  scheduleParcelSearchTimeout(parcelId);
}

/**
 * Attach nearest parcel-hub seller for visibility / seller panel.
 * Does NOT mark the parcel ACCEPTED — delivery riders still need SEARCHING broadcast.
 */
export async function tryAutoAssignParcelToSeller(parcelDoc) {
  const lat = Number(parcelDoc.pickupAddress?.lat);
  const lng = Number(parcelDoc.pickupAddress?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const seller = await findNearestParcelSellerNearPickup(lat, lng);
  if (!seller?._id) return null;

  const updated = await Parcel.findOneAndUpdate(
    {
      _id: parcelDoc._id,
      sellerId: null,
      status: { $in: ["REQUESTED", "SEARCHING"] },
    },
    {
      $set: {
        sellerId: seller._id,
      },
    },
    { new: true },
  );

  if (!updated) return null;

  emitToSeller(String(seller._id), {
    event: "parcel:auto-assigned",
    payload: {
      parcelId: String(updated._id),
      parcel: updated,
    },
  });

  emitToAdmins("parcel:status:update", updated);

  return updated;
}

export async function fetchParcelsForSeller(sellerId) {
  const seller = await getApprovedParcelSeller(sellerId);
  if (!seller) return [];

  const coords = seller.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    return Parcel.find({ sellerId })
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
  }

  const [sellerLng, sellerLat] = coords;
  const radiusKm = Math.min(Math.max(Number(seller.serviceRadius) || 5, 1), 100);
  const radiusM = radiusKm * 1000;

  const [assigned, nearbyOpen] = await Promise.all([
    Parcel.find({ sellerId })
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    Parcel.find({
      sellerId: null,
      status: { $in: ["REQUESTED", "SEARCHING"] },
    })
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const assignedIds = new Set(assigned.map((p) => String(p._id)));
  const nearby = nearbyOpen.filter((parcel) => {
    const pickupLat = Number(parcel.pickupAddress?.lat);
    const pickupLng = Number(parcel.pickupAddress?.lng);
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) return false;
    return distanceMeters(pickupLat, pickupLng, sellerLat, sellerLng) <= radiusM;
  });

  const merged = [...assigned];
  for (const parcel of nearby) {
    if (!assignedIds.has(String(parcel._id))) {
      merged.push(parcel);
    }
  }

  return merged.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** A booking whose pickup is still in the future waits for its time. */
export function isHeldForScheduledPickup(parcelDoc, now = new Date()) {
  const at = parcelDoc?.scheduledPickupAt ? new Date(parcelDoc.scheduledPickupAt) : null;
  return Boolean(at && !Number.isNaN(at.getTime()) && at.getTime() > now.getTime());
}

/**
 * Releases scheduled bookings whose pickup time has arrived. Runs every
 * minute from the scheduler; each release goes through startParcelBroadcast.
 */
export async function dispatchDueScheduledParcels(now = new Date()) {
  const due = await Parcel.find({
    awaitingScheduledDispatch: true,
    status: "REQUESTED",
    deliveryPartnerId: null,
    scheduledPickupAt: { $lte: now },
  })
    .limit(200)
    .lean();

  let released = 0;
  for (const parcel of due) {
    try {
      // Claim first so two scheduler processes cannot release the same booking.
      const claimed = await Parcel.updateOne(
        { _id: parcel._id, awaitingScheduledDispatch: true },
        { $set: { awaitingScheduledDispatch: false } },
      );
      if (!claimed.modifiedCount) continue;
      await startParcelBroadcast(parcel);
      released += 1;
    } catch (err) {
      console.warn("[scheduledDispatch] release failed", String(parcel._id), err?.message);
    }
  }
  return { released };
}

export async function startParcelBroadcast(parcelDoc) {
  // Not yet time: keep the paid booking on REQUESTED and let the scheduled sweep release it.
  if (isHeldForScheduledPickup(parcelDoc)) {
    await Parcel.updateOne(
      { _id: parcelDoc._id, status: "REQUESTED" },
      { $set: { awaitingScheduledDispatch: true } },
    );
    return parcelDoc;
  }

  // Only local parcels attach to nearby seller hubs. Outstation parcels
  // already have their drop destination (the customer-selected courier
  // company) set at creation time — see createParcel in parcelController.js —
  // and NEVER emit to seller app.
  if (parcelDoc.parcelType === "local") {
    await tryAutoAssignParcelToSeller(parcelDoc);
  }

  const parcelId = parcelDoc._id?.toString?.() || String(parcelDoc._id);

  const updated = await Parcel.findByIdAndUpdate(
    parcelDoc._id,
    { $set: { status: "SEARCHING" } },
    { new: true },
  );

  if (!updated) return null;

  await recordParcelEvent({
    parcelId: updated._id,
    status: "SEARCHING",
    previousStatus: "REQUESTED",
    actor: PARCEL_EVENT_ACTOR.SYSTEM,
    note: "Looking for a delivery partner",
  });

  emitToAdmins("parcel:status:update", updated);

  emitToCustomer(updated.customerId, {
    event: "parcel:status:update",
    payload: {
      parcelId,
      status: "SEARCHING",
      parcel: updated,
    },
  });

  // Offers the nearest rider in radius; falls back to manual assignment
  // itself if there's nobody to offer it to at all.
  await offerParcelToNextRider(parcelId);

  return updated;
}

/**
 * The currently-offered rider didn't respond in time — same path an
 * explicit reject takes (see parcelRejectAtomic): mark them skipped, dismiss
 * their now-stale offer, and move to the next-nearest rider.
 */
export async function processParcelSearchTimeout(parcelId) {
  const now = new Date();
  const parcel = await Parcel.findById(parcelId);
  if (!parcel || parcel.status !== "SEARCHING" || parcel.deliveryPartnerId) return;

  if (parcel.searchExpiresAt && parcel.searchExpiresAt > now) {
    return;
  }

  const offeredTo = parcel.searchMeta?.offeredTo;
  if (offeredTo) {
    await Parcel.updateOne(
      { _id: parcelId, status: "SEARCHING" },
      {
        $addToSet: { offerTimeoutBy: offeredTo },
        $set: { "searchMeta.offeredTo": null, "searchMeta.offeredAt": null },
      },
    );
    await retractParcelBroadcast(String(parcelId), null);
  }

  await offerParcelToNextRider(parcelId);
}

export async function fetchAvailableParcelsForRider(deliveryId) {
  const deliveryOid = toDeliveryObjectId(deliveryId);
  if (!deliveryOid) return [];

  const rider = await Delivery.findById(deliveryOid)
    .select("location isParcelService isVerified isOnline zoneIds")
    .lean();

  if (
    !rider?.isParcelService ||
    !rider.isVerified ||
    !rider.isOnline
  ) {
    return [];
  }

  if (await deliveryPartnerHasActiveJob(deliveryOid)) {
    return [];
  }

  /**
   * A rider at their COD cash limit is offered nothing — outstation included.
   *
   * The limit is a property of the rider, not of the product: the whole point
   * is to cap how much of the platform's money one person is carrying, and a
   * cap that only applied to local jobs would be trivially worked around by
   * taking outstation ones instead.
   */
  const cashGate = await assertRiderCanTakeJobs(deliveryOid);
  if (!cashGate.allowed) return [];

  const coords = rider.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return [];

  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const now = new Date();
  const settings = await ParcelConfig.getSearchSettings();
  // "searchMeta.offeredTo": this rider — the sequential flow offers one
  // rider at a time (nearest first, see offerParcelToNextRider); without
  // this filter, a rider further down the queue could open the "available
  // jobs" tab and accept a parcel out of turn, before the system ever
  // offered it to them. Showing it here only once it's genuinely their turn
  // keeps the pull feed and the push offer in agreement.
  const parcels = await Parcel.find({
    status: "SEARCHING",
    deliveryPartnerId: null,
    searchExpiresAt: { $gt: now },
    skippedBy: { $ne: deliveryOid },
    offerTimeoutBy: { $ne: deliveryOid },
    "searchMeta.offeredTo": deliveryOid,
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  const assignedZoneIds = (rider.zoneIds || []).map(String);

  const filtered = [];
  for (const parcel of parcels) {
    const pickupLat = Number(parcel.pickupAddress?.lat);
    const pickupLng = Number(parcel.pickupAddress?.lng);
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) continue;

    const radiusKm = settings.deliveryRadiusKm;
    if (distanceMeters(pickupLat, pickupLng, lat, lng) > radiusKm * 1000) continue;

    // Same zone rule the broadcast and the claim both enforce (see
    // offerParcelToNextRider / assertRiderWithinPickupRadius above) —
    // otherwise the pull feed would hand a rider a job the push would never
    // have sent them, and the claim would then refuse.
    if (parcel.zoneId) {
      const inZone = assignedZoneIds.length
        ? assignedZoneIds.includes(String(parcel.zoneId))
        : await isPointInZoneId(parcel.zoneId, lat, lng);
      if (!inZone) continue;
    }

    filtered.push(parcel);
  }

  return filtered;
}

export async function parcelAcceptAtomic(deliveryId, parcelId, idempotencyKey) {
  const deliveryOid = toDeliveryObjectId(deliveryId);
  if (!deliveryOid) {
    const err = new Error("Invalid delivery account");
    err.statusCode = 400;
    throw err;
  }

  const partner = await Delivery.findById(deliveryOid)
    .select("isVerified isParcelService name phone")
    .lean();

  if (!partner?.isVerified) {
    const err = new Error("Your account is pending admin approval.");
    err.statusCode = 403;
    throw err;
  }

  if (!partner.isParcelService) {
    const err = new Error("Courier delivery service is not enabled on your account.");
    err.statusCode = 403;
    throw err;
  }

  if (await deliveryPartnerHasActiveJob(deliveryOid)) {
    const err = new Error("Finish your current job before taking another.");
    err.statusCode = 409;
    throw err;
  }

  /**
   * Checked on the claim as well as on the feed. The feed is a view; this is
   * the decision, and a rider holding an id from an earlier poll — or one who
   * crossed the limit on another job in between — would otherwise walk
   * straight past a gate the list had already applied.
   *
   * Ordered AFTER the busy check on purpose. A rider who is both mid-job and
   * over their limit needs to hear "finish your current job" — that is the
   * thing they can act on right now, and it is true regardless of their cash
   * balance. Leading with the cash message would send them off to make a
   * deposit that would not have unblocked them anyway.
   */
  const cashGate = await assertRiderCanTakeJobs(deliveryOid);
  if (!cashGate.allowed) {
    const err = new Error(cashGate.message);
    err.statusCode = 403;
    err.code = "CASH_LIMIT_REACHED";
    err.cashStatus = cashGate.status;
    throw err;
  }

  await assertRiderWithinPickupRadius(deliveryOid, parcelId);

  if (idempotencyKey) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const cacheKey = `idem:parcel_accept:${parcelId}:${idempotencyKey}`;
        const hit = await redis.get(cacheKey);
        if (hit) {
          const parcel = await Parcel.findById(parcelId)
            .populate("customerId", "name phone")
            .populate("sellerId", "name shopName phone address location")
            .populate("courierCompanyId", "name phone")
            .lean();
          return { parcel, duplicate: true };
        }
      }
    } catch {
      /* optional */
    }
  }

  const now = new Date();
  // Snapshot of where the rider physically stood when they accepted — this
  // is what their payout gets computed against (see computeRiderParcelEarnings),
  // not their live location later on.
  const acceptCoords = (
    await Delivery.findById(deliveryOid).select("location").lean()
  )?.location?.coordinates;
  const riderAcceptLocation =
    Array.isArray(acceptCoords) && acceptCoords.length >= 2
      ? { lat: Number(acceptCoords[1]), lng: Number(acceptCoords[0]) }
      : null;

  const updated = await Parcel.findOneAndUpdate(
    {
      _id: parcelId,
      status: "SEARCHING",
      deliveryPartnerId: null,
      searchExpiresAt: { $gt: now },
      skippedBy: { $nin: [deliveryOid] },
      // Sequential dispatch offers one rider at a time (nearest first, see
      // offerParcelToNextRider) — this is the server-side half of that: only
      // the rider it's currently offered to can actually claim it, even if
      // someone else somehow still has a stale screen open for it.
      "searchMeta.offeredTo": deliveryOid,
    },
    {
      $set: {
        deliveryPartnerId: deliveryOid,
        status: "ACCEPTED",
        acceptedAt: now,
        ...(riderAcceptLocation ? { riderAcceptLocation } : {}),
      },
      $unset: { searchExpiresAt: 1, searchMeta: 1 },
    },
    { new: true },
  )
    .populate("customerId", "name phone")
    .populate("deliveryPartnerId", "name phone vehicleType vehicleNumber profileImage location")
    .populate("sellerId", "name shopName phone address location")
    .populate("courierCompanyId", "name phone");

  if (!updated) {
    const existing = await Parcel.findById(parcelId).lean();
    if (!existing) {
      const err = new Error("Courier not found");
      err.statusCode = 404;
      throw err;
    }
    let msg = "Courier already assigned or not available";
    if (existing.searchExpiresAt && new Date(existing.searchExpiresAt) <= now) {
      msg = "Accept window has expired. Wait for the next courier request.";
    } else if (existing.deliveryPartnerId) {
      msg = "Another rider already accepted this courier.";
    } else if (
      (existing.skippedBy || []).some(
        (id) => id.toString() === deliveryOid.toString(),
      )
    ) {
      msg = "You rejected this courier earlier.";
    } else if (existing.status !== "SEARCHING") {
      msg = "This courier is no longer open for acceptance.";
    } else if (
      existing.searchMeta?.offeredTo &&
      String(existing.searchMeta.offeredTo) !== String(deliveryOid)
    ) {
      msg = "This courier is currently offered to another rider.";
    }
    const err = new Error(msg);
    err.statusCode = 409;
    throw err;
  }

  // Flipped immediately after the atomic claim succeeds, before anything else
  // async runs — closes the window where a concurrent broadcast query for a
  // *different* parcel could still read this rider as free.
  await markDeliveryPartnerBusy(deliveryOid);
  clearParcelSearchTimeout(parcelId);
  await retractParcelBroadcast(String(parcelId), deliveryOid);

  await recordParcelEvent({
    parcelId: updated._id,
    status: "ACCEPTED",
    previousStatus: "SEARCHING",
    actor: PARCEL_EVENT_ACTOR.DELIVERY,
    actorId: deliveryOid,
    note: "Rider accepted the delivery",
  });

  emitToAdmins("parcel:status:update", updated);

  emitToDelivery(deliveryOid, {
    event: "parcel:assigned",
    payload: updated,
  });

  emitToCustomer(updated.customerId?._id || updated.customerId, {
    event: "parcel:status:update",
    payload: {
      parcelId: String(parcelId),
      status: "ACCEPTED",
      parcel: updated,
    },
  });

  emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_ASSIGNED, {
    deliveryId: deliveryOid,
    parcelId: String(parcelId),
    bodyKey: "rider_accepted_pickup",
    bodyVars: { address: updated.pickupAddress?.fullAddress || "pickup location" },
  });

  emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE, {
    userId: updated.customerId?._id || updated.customerId,
    customerId: updated.customerId?._id || updated.customerId,
    parcelId: String(parcelId),
    bodyKey: "status_accepted",
  });

  if (idempotencyKey) {
    try {
      const redis = getRedisClient();
      if (redis) {
        await redis.set(
          `idem:parcel_accept:${parcelId}:${idempotencyKey}`,
          "1",
          "EX",
          86400,
        );
      }
    } catch {
      /* optional */
    }
  }

  return { parcel: updated, duplicate: false };
}

export async function parcelRejectAtomic(deliveryId, parcelId, { timeout = false } = {}) {
  const deliveryOid = toDeliveryObjectId(deliveryId);
  if (!deliveryOid) {
    const err = new Error("Invalid delivery account");
    err.statusCode = 400;
    throw err;
  }

  const updated = await Parcel.findOneAndUpdate(
    { _id: parcelId, status: "SEARCHING" },
    {
      // A timeout is not a rejection: it goes to its own list so history stays accurate.
      $addToSet: timeout ? { offerTimeoutBy: deliveryOid } : { skippedBy: deliveryOid },
      $set: { "searchMeta.offeredTo": null, "searchMeta.offeredAt": null },
    },
  );

  // Only advance if this rider was actually the one currently holding the
  // offer — a reject on a parcel already moved on (or already accepted by
  // someone else) is a no-op, not a reason to re-trigger dispatch.
  if (updated && String(updated.searchMeta?.offeredTo || "") === String(deliveryOid)) {
    clearParcelSearchTimeout(parcelId);
    await retractParcelBroadcast(String(parcelId), null);
    await offerParcelToNextRider(parcelId).catch((err) => {
      console.warn("[parcelWorkflow] offer-next after reject failed", parcelId, err.message);
    });
  }

  return { ok: true };
}

export function cancelParcelSearch(parcelId) {
  clearParcelSearchTimeout(parcelId);
}

export function cancelAllParcelSearchTimers() {
  for (const timer of timeoutTimers.values()) {
    clearTimeout(timer);
  }
  timeoutTimers.clear();
}
