import Admin from "../../models/admin.js";
import { startParcelBroadcast } from "../parcelWorkflowService.js";
import {
  emitToAdmins,
  emitToCustomer,
  emitParcelNewToNearbySellers,
} from "../orderSocketEmitter.js";
import { recordParcelEvent, PARCEL_EVENT_ACTOR } from "../parcelEventService.js";
import { emitNotificationEvent } from "../../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../../modules/notifications/notification.constants.js";
import { PORTER_BOOKING_KIND } from "../../constants/porterPayment.js";
import logger from "../logger.js";

/**
 * Releasing a paid porter booking to riders.
 *
 * Extracted here because THREE different paths now need it — the customer's
 * own verify call, the gateway webhook, and the reconciliation sweep — and
 * before this each of them either had its own copy or simply did not exist.
 * The webhook path not existing is what made an abandoned browser lose a
 * paid booking: the money was taken, and nobody was ever sent to collect the
 * parcel.
 *
 * Every step here is safe to run twice. The broadcast starters are themselves
 * conditional on the booking still being unassigned, and the notifications
 * are advisory. That matters because a webhook and a client verify routinely
 * both land for the same payment, milliseconds apart, and neither can know
 * which of them got there first.
 */

/** Outstation parcel: tell the admins and the hubs, then start the search. */
async function activateOutstationParcel(booking) {
  emitToAdmins("parcel:new", booking);
  await emitParcelNewToNearbySellers(booking).catch(() => {
    /* a hub that cannot be reached must not block dispatch */
  });

  await recordParcelEvent({
    parcelId: booking._id,
    status: booking.status,
    actor: PARCEL_EVENT_ACTOR.SYSTEM,
    note: "Payment confirmed",
  }).catch(() => {});

  try {
    const admins = await Admin.find().select("_id").lean();
    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_REQUESTED, {
      userId: booking.customerId,
      customerId: booking.customerId,
      adminIds: (admins || []).map((a) => a?._id).filter(Boolean),
      parcelId: booking._id,
      fare: booking.fare,
      customerBody: `Your parcel booking is confirmed. Searching for a nearby rider...`,
      adminBody: `Parcel #${String(booking._id).slice(-6)} booked for ₹${booking.fare}.`,
      data: { parcelId: booking._id, fare: booking.fare },
    });
  } catch (error) {
    logger.warn("porter_parcel_notify_failed", {
      parcelId: String(booking._id),
      message: error?.message,
    });
  }

  const searching = await startParcelBroadcast(booking);
  return searching || booking;
}

/**
 * The one hook the payment layer calls once money is captured.
 *
 * Takes the booking document rather than an id because the caller has just
 * saved it, and re-reading would race its own write.
 */
export async function activatePorterBookingAfterPayment(booking) {
  if (!booking) return null;

  const kind = PORTER_BOOKING_KIND.PARCEL;
  const activated = await activateOutstationParcel(booking);

  emitToCustomer(String(booking.customerId), "porter:payment:confirmed", {
    kind,
    bookingId: String(booking._id),
    referenceId: booking.referenceId || String(booking._id),
    paymentStatus: "PAID",
  });

  logger.info("porter_booking_activated", {
    kind,
    bookingId: String(booking._id),
  });

  return activated;
}
