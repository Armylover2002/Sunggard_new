import mongoose from "mongoose";
import Parcel from "../models/parcel.js";
import Delivery from "../models/delivery.js";
import Notification from "../models/notification.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { cancelAllParcelSearchTimers } from "./parcelWorkflowService.js";
import { syncDeliveryPartnerBusyFlag } from "./deliveryBusyService.js";

const ACTIVE_PARCEL_STATUSES = [
  "REQUESTED",
  "SEARCHING",
  "ACCEPTED",
  "RIDER_ASSIGNED",
  "PICKUP_REACHED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

const BOOKING_NOTIFICATION_TYPES = [
  // Outstation / standard parcel
  NOTIFICATION_EVENTS.PARCEL_REQUESTED,
  NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST,
  NOTIFICATION_EVENTS.PARCEL_ASSIGNED,
  NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
  NOTIFICATION_EVENTS.PARCEL_DELIVERED,
];

/**
 * Reset existing Parcel bookings and free all riders (or a specific rider by
 * phone) so fresh bookings can be tested.
 *
 * @param {Object} options
 * @param {boolean} [options.wipe=false] - If true, permanently delete parcel bookings.
 * @param {string} [options.phone=null] - Specific rider phone to reset. If omitted, resets all riders.
 * @param {boolean} [options.makeReady=true] - Ensure riders are online, verified, and have the parcel flag enabled.
 * @param {[number, number]} [options.coordinates=null] - [lng, lat] GeoJSON coordinates to assign to riders.
 * @returns {Promise<Object>} Summary of reset operations.
 */
export async function resetBookingsAndFreeRiders(options = {}) {
  const {
    wipe = false,
    phone = null,
    makeReady = true,
    coordinates = null,
  } = options;

  const summary = {
    parcelsCancelled: 0,
    parcelsDeleted: 0,
    parcelSkipsCleared: 0,
    notificationsDeleted: 0,
    ridersUpdated: 0,
    riders: [],
  };

  // 1. Cancel in-memory parcel search timers
  try {
    cancelAllParcelSearchTimers();
  } catch (err) {
    // Ignore in case timer map is empty or uninitialized
  }

  // 2. Reset / Wipe Outstation / Pickup Parcels
  if (wipe) {
    const pDel = await Parcel.deleteMany({});
    summary.parcelsDeleted = pDel.deletedCount || 0;
  } else {
    const pUpdate = await Parcel.updateMany(
      { status: { $in: ACTIVE_PARCEL_STATUSES } },
      {
        $set: {
          status: "CANCELLED",
          deliveryPartnerId: null,
          acceptedAt: null,
          searchExpiresAt: null,
        },
      },
    );
    summary.parcelsCancelled = pUpdate.modifiedCount || 0;

    const pSkips = await Parcel.updateMany(
      { "skippedBy.0": { $exists: true } },
      { $set: { skippedBy: [] } },
    );
    summary.parcelSkipsCleared = pSkips.modifiedCount || 0;
  }

  // 3. Delete broadcast & booking notifications
  const notifDel = await Notification.deleteMany({
    $or: [
      { type: { $in: BOOKING_NOTIFICATION_TYPES } },
      { "data.parcelId": { $exists: true, $ne: null } },
      { title: /parcel|broadcast/i },
      { message: /parcel|broadcast/i },
    ],
  });
  summary.notificationsDeleted = notifDel.deletedCount || 0;

  // 4. Free and configure Riders
  const riderFilter = {};
  if (phone) {
    const rawPhone = String(phone).replace(/\D/g, "");
    riderFilter.phone = {
      $in: [phone, rawPhone, `+91${rawPhone}`, `91${rawPhone}`],
    };
  }

  const riderUpdateFields = {
    isBusy: false,
  };

  if (makeReady) {
    riderUpdateFields.isOnline = true;
    riderUpdateFields.isVerified = true;
    riderUpdateFields.isParcelService = true;
  }

  if (Array.isArray(coordinates) && coordinates.length === 2) {
    riderUpdateFields.location = {
      type: "Point",
      coordinates: [Number(coordinates[0]), Number(coordinates[1])],
    };
    riderUpdateFields.lastLocationAt = new Date();
  }

  const riderUpdateResult = await Delivery.updateMany(
    riderFilter,
    { $set: riderUpdateFields },
  );
  summary.ridersUpdated = riderUpdateResult.modifiedCount || 0;

  // Fetch updated rider documents for verification report
  const allRiders = await Delivery.find(riderFilter).lean();

  summary.riders = allRiders.map((r) => {
    const coords = r.location?.coordinates || [0, 0];
    const [lng, lat] = coords;
    const hasValidLocation =
      Array.isArray(coords) &&
      coords.length >= 2 &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      (Math.abs(lat) > 1e-5 || Math.abs(lng) > 1e-5);

    const issues = [];
    if (!r.isOnline) issues.push("Rider is OFFLINE (needs isOnline: true)");
    if (!r.isVerified) issues.push("Rider is UNVERIFIED (needs isVerified: true)");
    if (!r.isParcelService) issues.push("Parcel service disabled (needs isParcelService: true)");
    if (r.isBusy) issues.push("Rider is marked BUSY");
    if (!hasValidLocation) issues.push("Location coordinates are [0, 0] or unset");

    return {
      id: String(r._id),
      name: r.name || "N/A",
      phone: r.phone || "N/A",
      isOnline: Boolean(r.isOnline),
      isBusy: Boolean(r.isBusy),
      isVerified: Boolean(r.isVerified),
      isParcelService: Boolean(r.isParcelService),
      coordinates: coords,
      readyForTesting: issues.length === 0,
      issues,
    };
  });

  return summary;
}
