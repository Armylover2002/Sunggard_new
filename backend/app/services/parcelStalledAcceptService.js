import Parcel from "../models/parcel.js";
import ParcelEvent from "../models/parcelEvent.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { emitToAdmins, emitToCustomer, emitToDelivery } from "./orderSocketEmitter.js";
import { recordParcelEvent, PARCEL_EVENT_ACTOR } from "./parcelEventService.js";
import { syncDeliveryPartnerBusyFlag } from "./deliveryBusyService.js";
import { refundBookingPayment } from "./porter/porterPaymentService.js";
import { PORTER_BOOKING_KIND, PORTER_PAYMENT_SOURCE } from "../constants/porterPayment.js";
import logger from "./logger.js";

/**
 * A rider accepted a courier request and then went quiet: no status change
 * from the rider and nothing from the customer. Left alone, the request sits
 * in their queue forever. After this window with no status event, it is
 * cancelled automatically and any online payment is refunded.
 */
export const STALLED_ACCEPT_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Only the states before pickup. Once the rider has reached the customer the
// OTP flow owns the request, so it is never auto-cancelled.
const STALLED_STATUSES = ["ACCEPTED", "RIDER_ASSIGNED"];

const notify = (userId, role, bodyKey, bodyVars, parcelId) => {
  try {
    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE, {
      userId,
      customerId: role === "customer" ? userId : undefined,
      deliveryId: role === "delivery" ? userId : undefined,
      parcelId,
      status: "CANCELLED",
      titleKey: "stalled_cancelled_title",
      bodyKey,
      bodyVars,
      data: { parcelId, role, status: "CANCELLED" },
    });
  } catch (err) {
    logger.error("parcel_stalled_accept_notify_failed", { parcelId: String(parcelId), message: err?.message });
  }
};

const refundLine = (refund) => {
  if (!refund) return "";
  if (refund.status === "REFUNDED") {
    return refund.via === "WALLET"
      ? `₹${refund.amountRupees} has been added back to your wallet.`
      : `₹${refund.amountRupees} has been refunded to your original payment method.`;
  }
  if (refund.error) {
    return "We could not start your refund automatically. Our team will contact you.";
  }
  if (refund.attempted) return "Your refund is being processed.";
  return "";
};

async function cancelOne(parcel, now) {
  // Guarded on status: if the rider moved the request forward while we were
  // checking, this matches nothing and the request is left alone.
  const updated = await Parcel.findOneAndUpdate(
    { _id: parcel._id, status: { $in: STALLED_STATUSES } },
    { $set: { status: "CANCELLED", searchExpiresAt: null } },
    { new: true },
  );
  if (!updated) return false;

  const reason = "Auto-cancelled: no rider progress for 3 hours after acceptance";

  await recordParcelEvent({
    parcelId: updated._id,
    status: "CANCELLED",
    previousStatus: parcel.status,
    actor: PARCEL_EVENT_ACTOR.SYSTEM,
    note: reason,
  });

  const refund = await refundBookingPayment({
    kind: PORTER_BOOKING_KIND.PARCEL,
    bookingId: updated._id,
    reason,
    source: PORTER_PAYMENT_SOURCE.SYSTEM,
  }).catch((err) => {
    logger.error("parcel_stalled_accept_refund_threw", { parcelId: String(updated._id), message: err?.message });
    return { attempted: true, error: err?.message || "Refund failed" };
  });

  const finalParcel = refund?.booking || updated;
  const payload = { parcelId: String(updated._id), status: "CANCELLED", parcel: finalParcel };

  emitToAdmins("parcel:status:update", finalParcel);
  emitToCustomer(updated.customerId, {
    event: "parcel:status:update",
    payload: { ...payload, message: refundLine(refund) || undefined },
  });
  if (parcel.deliveryPartnerId) {
    emitToDelivery(parcel.deliveryPartnerId, { event: "parcel:status:update", payload });
    await syncDeliveryPartnerBusyFlag(parcel.deliveryPartnerId).catch(() => {});
  }

  // One combined body per outcome (bodyKey), since the refund outcome text
  // cannot be stitched in English and then translated per recipient.
  const customerBodyKey =
    refund?.status === "REFUNDED" ? "stalled_cancelled_refunded" : refund?.attempted ? "stalled_cancelled_pending" : "stalled_cancelled_base";
  notify(updated.customerId, "customer", customerBodyKey, { amount: refund?.amountRupees }, updated._id);

  if (parcel.deliveryPartnerId) {
    notify(parcel.deliveryPartnerId, "delivery", "stalled_cancelled_delivery_body", {}, updated._id);
  }

  logger.info("parcel_stalled_accept_cancelled", {
    parcelId: String(updated._id),
    refundStatus: refund?.status || (refund?.attempted ? "ATTEMPTED" : "NONE"),
    at: now.toISOString(),
  });
  return true;
}

/**
 * Cancels accepted-but-idle courier requests. Returns counts for logging.
 */
export async function cancelStalledAcceptedParcels(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALLED_ACCEPT_TIMEOUT_MS);

  const candidates = await Parcel.find({
    status: { $in: STALLED_STATUSES },
    deliveryPartnerId: { $ne: null },
    acceptedAt: { $lte: cutoff },
  })
    .select("_id status deliveryPartnerId customerId acceptedAt")
    .limit(200)
    .lean();

  let cancelled = 0;
  for (const parcel of candidates) {
    try {
      // The clock starts at the last status event, not at acceptance, so a
      // rider who moved the request forward recently gets the full window.
      const last = await ParcelEvent.findOne({ parcelId: parcel._id })
        .sort({ at: -1 })
        .select("at")
        .lean();
      const lastActivity = last?.at ? new Date(last.at) : new Date(parcel.acceptedAt);
      if (lastActivity > cutoff) continue;

      if (await cancelOne(parcel, now)) cancelled += 1;
    } catch (err) {
      logger.error("parcel_stalled_accept_cancel_failed", {
        parcelId: String(parcel._id),
        message: err?.message,
      });
    }
  }

  return { checked: candidates.length, cancelled };
}
