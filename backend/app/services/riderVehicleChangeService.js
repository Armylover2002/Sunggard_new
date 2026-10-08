import Delivery from "../models/delivery.js";
import Parcel from "../models/parcel.js";
import Admin from "../models/admin.js";
import Notification from "../models/notification.js";
import { clearRiderPresence } from "./firebaseService.js";
import logger from "./logger.js";

/**
 * A rider changing their vehicle details — type, plate number, driving
 * licence — goes back through admin approval.
 *
 * How it works:
 *   - The rider asks for the change. The CURRENT (already approved) values
 *     stay on the rider; the requested values are held in `vehicleChange`
 *     next to a snapshot of what they were, so the admin can see exactly what
 *     is changing and from what.
 *   - While the request is open the account is "waiting for approval" again:
 *     isVerified false, applicationStatus pending, forced offline — the same
 *     state a new application is in, which the rest of the product (the
 *     pending screen, "cannot go online", no job offers) already honours.
 *   - Approve: the requested values are applied and the account is verified
 *     again. Reject: the request is discarded with a reason, and the rider is
 *     restored to exactly what they had — a rejected change never costs
 *     someone their account.
 *
 * Nothing else is touched. Documents, bank details, wallet, ratings and
 * history are not part of this.
 */

/** Types a rider can pick. "cycle" is no longer offered. */
export const ALLOWED_VEHICLE_TYPES = ["bike", "scooter"];

const PLATE_REGEX = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/;
const LICENSE_REGEX = /^(DL[0-9]{13}|[A-Z]{2}[0-9]{2}[0-9]{4}[0-9]{7})$/;

const normalizePlate = (value) => String(value || "").replace(/\s/g, "").toUpperCase();
const normalizeLicense = (value) => String(value || "").replace(/[\s-]/g, "").toUpperCase();

const httpError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const TYPE_LABELS = { bike: "Bike", scooter: "Scooter", cycle: "Cycle" };
const typeLabel = (type) => TYPE_LABELS[type] || type || "—";

/** "Bike → Scooter · Plate MH12AB0000 → MH12AB1111" for notification text. */
function describeChange(previous = {}, requested = {}) {
  const parts = [];
  if (requested.vehicleType) {
    parts.push(`Type ${typeLabel(previous.vehicleType)} → ${typeLabel(requested.vehicleType)}`);
  }
  if (requested.vehicleNumber) {
    parts.push(`Plate ${previous.vehicleNumber || "—"} → ${requested.vehicleNumber}`);
  }
  if (requested.drivingLicenseNumber) {
    parts.push(`Licence ${previous.drivingLicenseNumber || "—"} → ${requested.drivingLicenseNumber}`);
  }
  return parts.join(" · ");
}

async function notifyRider(riderId, title, message) {
  try {
    await Notification.create({
      recipient: riderId,
      recipientModel: "Delivery",
      title,
      message,
      type: "alert",
    });
  } catch (error) {
    logger.warn("vehicle_change_rider_notify_failed", { riderId: String(riderId), message: error?.message });
  }
}

async function notifyAdmins(title, message) {
  try {
    const admins = await Admin.find().select("_id").lean();
    if (!admins.length) return;
    await Notification.insertMany(
      admins.map((admin) => ({
        recipient: admin._id,
        recipientModel: "Admin",
        title,
        message,
        type: "alert",
      })),
      { ordered: false },
    );
  } catch (error) {
    logger.warn("vehicle_change_admin_notify_failed", { message: error?.message });
  }
}

/**
 * The rider asks to change their vehicle details.
 * Only fields that actually differ from the current values are recorded.
 */
export async function submitVehicleChange(riderId, body = {}) {
  const rider = await Delivery.findById(riderId);
  if (!rider) throw httpError("Delivery partner not found", 404);

  if (!rider.isVerified && rider.vehicleChange?.status !== "pending") {
    throw httpError("Your account is not approved yet, so vehicle details cannot be changed.", 403);
  }

  const requested = {};

  if (body.vehicleType !== undefined && body.vehicleType !== "") {
    const type = String(body.vehicleType).trim().toLowerCase();
    if (!ALLOWED_VEHICLE_TYPES.includes(type)) {
      throw httpError("Choose Bike or Scooter as your vehicle type.");
    }
    if (type !== rider.vehicleType) requested.vehicleType = type;
  }

  if (body.vehicleNumber !== undefined && String(body.vehicleNumber).trim() !== "") {
    const plate = normalizePlate(body.vehicleNumber);
    if (!PLATE_REGEX.test(plate)) {
      throw httpError("Vehicle plate must be 2 letters, 2 digits, 2 letters, then 4 digits (e.g. KA 05 MN 8921).");
    }
    if (plate !== normalizePlate(rider.vehicleNumber)) requested.vehicleNumber = plate;
  }

  if (body.drivingLicenseNumber !== undefined && String(body.drivingLicenseNumber).trim() !== "") {
    const licence = normalizeLicense(body.drivingLicenseNumber);
    if (!LICENSE_REGEX.test(licence)) {
      throw httpError("Driving licence must be DL- followed by 13 digits, or the 15-character state format.");
    }
    if (licence !== normalizeLicense(rider.drivingLicenseNumber)) requested.drivingLicenseNumber = licence;
  }

  if (!Object.keys(requested).length) {
    throw httpError("Nothing has changed. Update at least one detail to request a change.");
  }

  // Switching a rider to "waiting for approval" mid-job would strand a parcel
  // they are carrying, so it waits until they have finished.
  const activeJob = await Parcel.exists({
    deliveryPartnerId: rider._id,
    status: { $nin: ["DELIVERED", "CANCELLED"] },
  });
  if (activeJob) {
    throw httpError("Finish your current delivery before changing your vehicle details.", 409);
  }

  const alreadyPending = rider.vehicleChange?.status === "pending";
  const previous = alreadyPending
    ? rider.vehicleChange.previous
    : {
        vehicleType: rider.vehicleType,
        vehicleNumber: rider.vehicleNumber,
        drivingLicenseNumber: rider.drivingLicenseNumber,
      };

  rider.vehicleChange = {
    status: "pending",
    requestedAt: new Date(),
    previous,
    requested,
    rejectionReason: "",
    reviewedAt: null,
  };
  // Back to "waiting for approval" — see the note at the top of this file.
  rider.isVerified = false;
  rider.applicationStatus = "pending";
  rider.isOnline = false;
  await rider.save();

  clearRiderPresence(String(rider._id)).catch(() => {});

  const summary = describeChange(previous, requested);
  await notifyAdmins(
    "Vehicle change request",
    `${rider.name || "A rider"} wants to change vehicle details: ${summary}. Review it under Waiting For Review.`,
  );

  logger.info("rider_vehicle_change_requested", { riderId: String(rider._id), fields: Object.keys(requested) });
  return rider;
}

/** The rider withdraws their own pending request and gets back to work. */
export async function cancelVehicleChange(riderId) {
  const rider = await Delivery.findById(riderId);
  if (!rider) throw httpError("Delivery partner not found", 404);
  if (rider.vehicleChange?.status !== "pending") {
    throw httpError("There is no pending vehicle change to cancel.", 409);
  }

  rider.vehicleChange = { status: "none", requestedAt: null, previous: {}, requested: {}, rejectionReason: "", reviewedAt: null };
  rider.isVerified = true;
  rider.applicationStatus = "approved";
  await rider.save();
  return rider;
}

/** Admin approves: the requested values go live and the account is verified again. */
export async function approveVehicleChange(riderId) {
  const rider = await Delivery.findById(riderId);
  if (!rider || rider.vehicleChange?.status !== "pending") return null;

  const requested = rider.vehicleChange.requested || {};
  if (requested.vehicleType) rider.vehicleType = requested.vehicleType;
  if (requested.vehicleNumber) rider.vehicleNumber = requested.vehicleNumber;
  if (requested.drivingLicenseNumber) rider.drivingLicenseNumber = requested.drivingLicenseNumber;

  rider.vehicleChange.status = "approved";
  rider.vehicleChange.reviewedAt = new Date();
  rider.vehicleChange.rejectionReason = "";
  rider.isVerified = true;
  rider.applicationStatus = "approved";
  await rider.save();

  await notifyRider(
    rider._id,
    "Vehicle details approved ✅",
    "Your vehicle change was approved. Your account is active again — you can go online.",
  );
  return rider;
}

/** Admin rejects: the request is discarded and the rider is restored as they were. */
export async function rejectVehicleChange(riderId, reason) {
  const rider = await Delivery.findById(riderId);
  if (!rider || rider.vehicleChange?.status !== "pending") return null;

  rider.vehicleChange.status = "rejected";
  rider.vehicleChange.reviewedAt = new Date();
  rider.vehicleChange.rejectionReason = reason;
  // Their approved details were never overwritten, so restoring is just
  // letting them back in.
  rider.isVerified = true;
  rider.applicationStatus = "approved";
  await rider.save();

  await notifyRider(
    rider._id,
    "Vehicle change not approved",
    `Your vehicle change request was not approved: ${reason}. Your previous vehicle details are unchanged and your account is active.`,
  );
  return rider;
}
