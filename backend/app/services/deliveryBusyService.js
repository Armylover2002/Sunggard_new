import mongoose from "mongoose";
import Delivery from "../models/delivery.js";
import Parcel from "../models/parcel.js";

const ACTIVE_PARCEL = [
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
