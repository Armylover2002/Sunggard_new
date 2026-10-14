import mongoose from "mongoose";
import Delivery from "../models/delivery.js";
import Parcel from "../models/parcel.js";

export const ACTIVE_PARCEL = [
  "ACCEPTED",
  "RIDER_ASSIGNED",
  "PICKUP_REACHED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

function toOid(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return new mongoose.Types.ObjectId(String(id));
}

export async function markDeliveryPartnerBusy(deliveryId) {
  const oid = toOid(deliveryId);
  if (!oid) return;
  await Delivery.findByIdAndUpdate(oid, { $set: { isBusy: true } });
}

export async function clearDeliveryPartnerBusy(deliveryId) {
  const oid = toOid(deliveryId);
  if (!oid) return;
  await Delivery.findByIdAndUpdate(oid, { $set: { isBusy: false } });
}

export async function getDeliveryPartnerActiveJobInfo(deliveryId) {
  const oid = toOid(deliveryId);
  if (!oid) return { hasActiveJob: false, type: null };

  const parcel = await Parcel.exists({
    deliveryPartnerId: oid,
    status: { $in: ACTIVE_PARCEL },
  });

  if (parcel) return { hasActiveJob: true, type: "PARCEL" };
  return { hasActiveJob: false, type: null };
}

/**
 * How many accepted jobs a rider may hold in their "waiting" list on top of
 * the one they are working. 0 turns the waiting list off entirely, which is
 * the old one-job-at-a-time behaviour.
 */
export function getMaxQueuedJobs() {
  const n = parseInt(process.env.RIDER_MAX_QUEUED_JOBS ?? "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Started (live) jobs vs jobs waiting in the rider's queue. */
export async function getRiderJobLoad(deliveryId) {
  const oid = toOid(deliveryId);
  if (!oid) return { activeCount: 0, queuedCount: 0 };
  const rows = await Parcel.aggregate([
    { $match: { deliveryPartnerId: oid, status: { $in: ACTIVE_PARCEL } } },
    { $group: { _id: { $eq: ["$isQueued", true] }, n: { $sum: 1 } } },
  ]);
  let activeCount = 0;
  let queuedCount = 0;
  for (const row of rows) {
    if (row._id === true) queuedCount += row.n;
    else activeCount += row.n;
  }
  return { activeCount, queuedCount };
}

/** Same as getRiderJobLoad for many riders at once, keyed by rider id string. */
export async function getRiderJobLoads(deliveryIds = []) {
  const oids = deliveryIds.map(toOid).filter(Boolean);
  const loads = new Map();
  if (!oids.length) return loads;
  const rows = await Parcel.aggregate([
    { $match: { deliveryPartnerId: { $in: oids }, status: { $in: ACTIVE_PARCEL } } },
    {
      $group: {
        _id: { rider: "$deliveryPartnerId", queued: { $eq: ["$isQueued", true] } },
        n: { $sum: 1 },
      },
    },
  ]);
  for (const row of rows) {
    const key = String(row._id.rider);
    const load = loads.get(key) || { activeCount: 0, queuedCount: 0 };
    if (row._id.queued) load.queuedCount += row.n;
    else load.activeCount += row.n;
    loads.set(key, load);
  }
  return loads;
}

/**
 * Can a rider with this load take one more job, and would it be queued?
 * A rider holding any accepted job (live or waiting) queues the new one, so
 * jobs are always started in the order they were taken.
 */
export function riderCapacity(load = {}) {
  const active = Number(load.activeCount) || 0;
  const queued = Number(load.queuedCount) || 0;
  if (!active && !queued) return { canTake: true, willQueue: false };
  const max = getMaxQueuedJobs();
  if (!max) {
    return { canTake: false, willQueue: true, reason: "Finish your current job before taking another." };
  }
  if (queued >= max) {
    return {
      canTake: false,
      willQueue: true,
      reason: `Your waiting list is full (${max}). Start or finish a job first.`,
    };
  }
  return { canTake: true, willQueue: true };
}

export async function deliveryPartnerHasActiveJob(deliveryId) {
  const info = await getDeliveryPartnerActiveJobInfo(deliveryId);
  return info.hasActiveJob;
}

export async function syncDeliveryPartnerBusyFlag(deliveryId) {
  const busy = await deliveryPartnerHasActiveJob(deliveryId);
  const oid = toOid(deliveryId);
  if (!oid) return busy;
  await Delivery.findByIdAndUpdate(oid, { $set: { isBusy: busy } });
  return busy;
}
