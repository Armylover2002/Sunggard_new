import Parcel from "../models/parcel.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { emitToAdmins, emitToCustomer, retractParcelBroadcast } from "./orderSocketEmitter.js";
import { recordParcelEvent, PARCEL_EVENT_ACTOR } from "./parcelEventService.js";
import { refundBookingPayment } from "./porter/porterPaymentService.js";
import { PORTER_BOOKING_KIND, PORTER_PAYMENT_SOURCE } from "../constants/porterPayment.js";
import { cancelParcelSearch } from "./parcelWorkflowService.js";
import logger from "./logger.js";

/**
 * Nobody ever accepted this booking — still SEARCHING (cycling through
 * riders) or REQUESTED (fell back to "needs manual admin assignment"
 * because no rider was ever eligible). Left alone it sits forever with
 * nobody ever acting on it. After this window with no driver assigned, it
 * is cancelled automatically and any online payment is refunded.
 *
 * `deliveryPartnerId: null` in every query below is load-bearing: the
 * moment a rider accepts, this field is set and the parcel's status moves
 * to ACCEPTED — permanently out of this service's reach, waiting-list or
 * not. Auto-cancelling an idle *accepted* booking is
 * parcelStalledAcceptService's job, not this one's. Keeping the two
 * services fully separate means a change here can never touch a booking a
 * rider has already accepted.
 */
export const STALLED_SEARCH_TIMEOUT_MS = parseInt(
  process.env.STALLED_SEARCH_TIMEOUT_MS || `${3 * 60 * 60 * 1000}`,
  10,
);

const UNACCEPTED_STATUSES = ["SEARCHING", "REQUESTED"];

const notify = (customerId, bodyKey, bodyVars, parcelId) => {
  try {
    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE, {
      userId: customerId,
      customerId,
      parcelId,
      status: "CANCELLED",
      titleKey: "stalled_unaccepted_cancelled_title",
      bodyKey,
      bodyVars,
      data: { parcelId, role: "customer", status: "CANCELLED" },
    });
  } catch (err) {
    logger.error("parcel_stalled_search_notify_failed", {
      parcelId: String(parcelId),
      message: err?.message,
    });
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
  // Guarded on status + still-unassigned: if a rider accepted it while we
  // were checking, this matches nothing and the booking is left alone.
  const updated = await Parcel.findOneAndUpdate(
    { _id: parcel._id, status: { $in: UNACCEPTED_STATUSES }, deliveryPartnerId: null },
    {
      $set: { status: "CANCELLED" },
      $unset: { searchExpiresAt: 1, searchMeta: 1, searchFallbackAt: 1 },
    },
    { new: true },
  );
  if (!updated) return false;

  cancelParcelSearch(String(updated._id));
  await retractParcelBroadcast(String(updated._id), null).catch(() => {});

  const reason = "Auto-cancelled: no driver accepted within the search window";

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
    logger.error("parcel_stalled_search_refund_threw", {
      parcelId: String(updated._id),
      message: err?.message,
    });
    return { attempted: true, error: err?.message || "Refund failed" };
  });

  const finalParcel = refund?.booking || updated;
  const payload = { parcelId: String(updated._id), status: "CANCELLED", parcel: finalParcel };

  emitToAdmins("parcel:status:update", finalParcel);
  emitToCustomer(updated.customerId, {
    event: "parcel:status:update",
    payload: { ...payload, message: refundLine(refund) || undefined },
  });

  const customerBodyKey =
    refund?.status === "REFUNDED"
      ? "stalled_unaccepted_cancelled_refunded"
      : refund?.attempted
        ? "stalled_unaccepted_cancelled_pending"
        : "stalled_unaccepted_cancelled_base";
  notify(updated.customerId, customerBodyKey, { amount: refund?.amountRupees }, updated._id);

  logger.info("parcel_stalled_search_cancelled", {
    parcelId: String(updated._id),
    previousStatus: parcel.status,
    refundStatus: refund?.status || (refund?.attempted ? "ATTEMPTED" : "NONE"),
    at: now.toISOString(),
  });
  return true;
}

/**
 * Cancels bookings nobody ever accepted within the search window. Returns
 * counts for logging.
 */
export async function cancelStalledUnacceptedParcels(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALLED_SEARCH_TIMEOUT_MS);

  const candidates = await Parcel.find({
    status: { $in: UNACCEPTED_STATUSES },
    deliveryPartnerId: null,
    createdAt: { $lte: cutoff },
  })
    .select("_id status customerId createdAt")
    .limit(200)
    .lean();

  let cancelled = 0;
  for (const parcel of candidates) {
    try {
      if (await cancelOne(parcel, now)) cancelled += 1;
    } catch (err) {
      logger.error("parcel_stalled_search_cancel_failed", {
        parcelId: String(parcel._id),
        message: err?.message,
      });
    }
  }

  return { checked: candidates.length, cancelled };
}
