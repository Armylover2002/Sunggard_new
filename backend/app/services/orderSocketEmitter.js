/**
 * Emits Socket.IO events for order workflow. Safe if socket not initialized.
 */

import mongoose from "mongoose";
import Notification from "../models/notification.js";
import Delivery from "../models/delivery.js";
import { getParcelRiderIdsNearPickup } from "./deliveryNearbyService.js";
import { getParcelSellerIdsNearPickup } from "./sellerNearbyService.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { translate, normalizeLanguage } from "../modules/notifications/notification.i18n.js";
import { offerDeadlineFields } from "./offerDeadline.js";

let _getIo = null;

export function registerOrderSocketGetter(fn) {
  _getIo = fn;
}

function getIo() {
  try {
    return _getIo ? _getIo() : null;
  } catch {
    return null;
  }
}

function normalizeSellerId(sellerId) {
  if (sellerId == null) return null;
  if (typeof sellerId === "object" && sellerId._id) {
    return sellerId._id.toString();
  }
  return String(sellerId);
}

function normalizeDeliveryId(deliveryId) {
  if (deliveryId == null) return null;
  if (typeof deliveryId === "object" && deliveryId._id) {
    return deliveryId._id.toString();
  }
  return String(deliveryId);
}

export function emitToSeller(sellerId, { event, payload }) {
  const s = getIo();
  if (!s || !sellerId) return;
  s.to(`seller:${sellerId}`).emit(event, payload);
}

export function emitToDelivery(deliveryId, { event, payload }) {
  const s = getIo();
  const id = normalizeDeliveryId(deliveryId);
  if (!s || !id) return;
  s.to(`delivery:${id}`).emit(event, payload);
}

/**
 * Emit a custom event to a single admin's per-admin room
 * (joined as `admin:<userId>` in socketManager.js). Used for
 * `notification:new` deltas that should only wake up the specific
 * admin who owns the Notification row.
 */
export function emitToAdmin(adminId, { event, payload }) {
  const s = getIo();
  if (!s || !adminId || !event) return;
  const id =
    adminId && typeof adminId === "object" && typeof adminId.toString === "function"
      ? adminId.toString()
      : String(adminId);
  s.to(`admin:${id}`).emit(event, payload);
}

export function emitToAdmins(event, payload) {
  const s = getIo();
  if (!s || !event) return;
  s.to("admin:orders").emit(event, payload);
}

/** Notify parcel hub sellers whose service radius covers the pickup location. */
/** Notify parcel hub sellers whose service radius covers the pickup location (local parcels only). */
export async function emitParcelNewToNearbySellers(parcel) {
  // Outstation parcels are routed to a courier company, never to sellers
  if (parcel?.parcelType && parcel.parcelType !== "local") {
    return;
  }

  const lat = Number(parcel?.pickupAddress?.lat);
  const lng = Number(parcel?.pickupAddress?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const sellerIds = await getParcelSellerIdsNearPickup(lat, lng);
  if (!sellerIds.length) return;

  const s = getIo();
  if (!s) return;

  const payload =
    parcel && typeof parcel.toObject === "function" ? parcel.toObject() : parcel;

  for (const sellerId of sellerIds) {
    s.to(`seller:${sellerId}`).emit("parcel:new", payload);
  }
}

/**
 * Emit a custom event to everyone who has joined the order room
 * (via `join_order`). Used for events that aren't pure workflow
 * status updates — e.g. `delivery:otp:validated`, `delivery:otp:generated`.
 */
export function emitToOrder(orderId, { event, payload }) {
  const s = getIo();
  if (!s || !orderId || !event) return;
  s.to(`order:${orderId}`).emit(event, payload);
}

/**
 * Push `data` for a rider job offer, built from the same payload the socket
 * broadcast carries so a backgrounded/killed app sees the same details.
 * Every field is optional; empty ones are dropped before sending.
 */
function offerPushData(payload = {}) {
  const preview = payload.preview || {};
  const deadlineFields = offerDeadlineFields(payload);
  return {
    role: "delivery",
    displayId: payload.displayId,
    type: preview.type || payload.type,
    pickupAddress: preview.pickup,
    dropAddress: preview.drop,
    weight: preview.weight,
    distanceKm: preview.distance ?? preview.distanceKm,
    earnings: preview.earnings,
    riderEarnings: preview.earnings,
    paymentMethod: preview.paymentMethod,
    collectAmount: preview.collectAmount,
    // `preview.total` was never set by parcelBroadcastPayloadFromDoc (the
    // only builder that feeds this), so this always shipped as undefined and
    // the app's "₹0" fallback kicked in. `fare` is the field that's actually
    // populated — the order amount, not the rider's payout (which is
    // `earnings`, correctly 0 pre-accept since the real payout distance
    // isn't known until the rider's accept location is).
    fare: preview.fare,
    total: preview.fare,
    ...deadlineFields,
  };
}

export function emitToCustomer(customerId, { event, payload }) {
  const s = getIo();
  if (!s || !customerId) return;
  s.to(`customer:${customerId}`).emit(event, payload);
}

/**
 * Send a parcel pickup offer to eligible parcel/both riders inside the
 * configured search radius.
 *
 * `zone`, when given (outstation bookings with a resolved zone — see
 * parcelWorkflowService.js), additionally confines candidates to riders
 * belonging to that zone, the same rule the local City Parcel broadcast
 * already enforces (see deliveryNearbyService.js).
 *
 * `riderIds`, when given, skips the radius lookup entirely and sends to
 * exactly those ids — this is how the sequential offer flow (one rider at a
 * time, nearest first, see parcelWorkflowService.offerParcelToNextRider)
 * reuses this same socket+push+tracking pipeline for a single candidate
 * instead of broadcasting to everyone in range.
 */
export async function emitParcelBroadcast(
  lat,
  lng,
  radiusKm,
  payload,
  { zone = null, riderIds = null } = {},
) {
  const s = getIo();
  // Parcel-only + "both" riders (isParcelService: true), online, verified.
  let ids = riderIds || (await getParcelRiderIdsNearPickup(lat, lng, radiusKm, { zone }));

  if (!ids.length) {
    return { ids: [] };
  }

  // De-dupe in case of any overlap.
  ids = [...new Set(ids.map((id) => String(id)))];

  /**
   * Riders at their COD cash limit are dropped before the fan-out, so the
   * push agrees with the pull feed and the accept gate. Reaching someone with
   * a job they will be refused on tap teaches them to ignore the alert.
   *
   * Imported lazily: this module is the socket layer and is loaded by almost
   * everything, while the cash service reads the booking models — a static
   * import would build a cycle through them.
   */
  const { filterRidersWithCashHeadroom } = await import(
    "./porter/riderCashLimitService.js"
  );
  ids = await filterRidersWithCashHeadroom(ids);
  if (!ids.length) {
    return { ids: [] };
  }

  // Same countdown fields as the push, computed at this emit, so the in-app
  // dialog starts at the real remaining time instead of falling back to 60s.
  const body = {
    ...payload,
    at: new Date().toISOString(),
    ...offerDeadlineFields(payload),
  };

  if (s) {
    for (const id of ids) {
      s.to(`delivery:${id}`).emit("parcel:broadcast", body);
    }
  }

  // The "New Parcel Request" push is deliberately first-round only — a rider
  // still in range on a retry already has the offer live on their screen
  // (the socket emit above just went to them again), so a second push would
  // just be a repeat alert for the same job.
  if (!payload.retryAttempt) {
    emitNotificationEvent(NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST, {
      parcelId: payload.parcelId,
      deliveryIds: ids,
      data: offerPushData(payload),
    });
  }

  /**
   * Tracks who currently holds a live offer for this parcel — every round,
   * not just the first. This is what retractParcelBroadcast's query reads to
   * decide who to dismiss, and it used to be written only inside the
   * `!retryAttempt` branch above. A rider reached only on a retry (a very
   * normal case — the first round can easily miss someone who comes online
   * or free up a minute later) was never recorded here, so a customer
   * cancelling afterward found no row for them: no dismiss push, no targeted
   * socket event, nothing — the offer stayed on their screen for the full
   * accept-window timeout no matter what the customer did.
   */
  try {
    // `type: "parcel"` and `data.parcelId` are load-bearing: retractParcelBroadcast
    // queries on exactly these to find who currently holds a live offer and
    // needs a dismiss push. Title/body are written in each rider's own
    // language — this row is inserted directly rather than through
    // notify(), so it has to translate itself instead of getting it for free.
    const riders = await Delivery.find({ _id: { $in: ids } }).select("language").lean();
    const langById = new Map(riders.map((r) => [String(r._id), normalizeLanguage(r.language)]));
    const code = String(payload.parcelId || "").slice(-6);

    await Notification.insertMany(
      ids.map((id) => {
        const lang = langById.get(String(id)) || "en";
        return {
          recipient: new mongoose.Types.ObjectId(id),
          recipientModel: "Delivery",
          title: translate(lang, "parcel_new_request_title"),
          message: translate(lang, "parcel_nearby_body", { code }),
          type: "parcel",
          data: {
            parcelId: payload.parcelId,
            preview: payload.preview || null,
            searchExpiresAt: payload.searchExpiresAt || null,
          },
        };
      }),
      { ordered: false },
    );
  } catch (e) {
    console.warn("[emitParcelBroadcast] notifications", e.message);
  }

  return { ids };
}

/**
 * Remove one rider's offer row and dismiss it on their device only. Used when
 * that rider rejects — the other riders' pending rows must stay so a later
 * accept can still withdraw them in real time.
 */
export async function retractParcelOfferForRider(parcelId, deliveryId) {
  const s = getIo();
  const id = normalizeDeliveryId(deliveryId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return { removedCount: 0 };

  if (s) {
    s.to(`delivery:${id}`).emit("parcel:broadcast:withdrawn", {
      parcelId: String(parcelId),
      winnerDeliveryId: null,
      at: new Date().toISOString(),
    });
  }

  try {
    const result = await Notification.deleteMany({
      recipient: new mongoose.Types.ObjectId(id),
      recipientModel: "Delivery",
      type: "parcel",
      "data.parcelId": String(parcelId),
    });
    return { removedCount: result?.deletedCount || 0 };
  } catch (error) {
    console.warn("[retractParcelOfferForRider] failed", parcelId, error.message);
    return { removedCount: 0 };
  }
}

/**
 * Retract a parcel offer from losing riders after first-wins accept.
 */
export async function retractParcelBroadcast(parcelId, winnerDeliveryId) {
  const s = getIo();
  const winnerId = normalizeDeliveryId(winnerDeliveryId);
  const winnerObjectId =
    winnerId && mongoose.Types.ObjectId.isValid(winnerId)
      ? new mongoose.Types.ObjectId(winnerId)
      : null;

  try {
    const query = {
      recipientModel: "Delivery",
      type: "parcel",
      "data.parcelId": String(parcelId),
    };

    if (winnerObjectId) {
      query.recipient = { $ne: winnerObjectId };
    }

    const notifications = await Notification.find(query)
      .select("_id recipient")
      .lean();

    if (!notifications.length) {
      if (s) {
        s.to("delivery:online").emit("parcel:broadcast:withdrawn", {
          parcelId: String(parcelId),
          winnerDeliveryId: winnerId,
          at: new Date().toISOString(),
        });
      }
      return { removedCount: 0 };
    }

    const recipientIds = [
      ...new Set(
        notifications
          .map((n) => n.recipient?.toString?.() || String(n.recipient || ""))
          .filter(Boolean),
      ),
    ];

    if (s) {
      for (const recipientId of recipientIds) {
        s.to(`delivery:${recipientId}`).emit("parcel:broadcast:withdrawn", {
          parcelId: String(parcelId),
          winnerDeliveryId: winnerId,
          at: new Date().toISOString(),
        });
      }
    }

    // Socket event above only reaches a rider whose app is open/foreground.
    // A push covers backgrounded/killed devices too, so the stale offer
    // dialog/overlay gets dismissed there as well (customer cancel, another
    // rider winning the job, or a server-side search timeout all land here).
    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED, {
      deliveryIds: recipientIds,
      parcelId: String(parcelId),
    });

    await Notification.deleteMany({
      recipientModel: "Delivery",
      type: "parcel",
      "data.parcelId": String(parcelId),
      ...(winnerObjectId ? { recipient: { $ne: winnerObjectId } } : {}),
    });

    return { removedCount: notifications.length };
  } catch (error) {
    console.warn("[retractParcelBroadcast] failed", parcelId, error.message);
    return { removedCount: 0 };
  }
}
