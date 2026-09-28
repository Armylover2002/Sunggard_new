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
  const expiresAt = payload.deliverySearchExpiresAt || payload.searchExpiresAt;
  const deadline = expiresAt ? new Date(expiresAt) : null;
  const hasDeadline = deadline && !Number.isNaN(deadline.getTime());
  return {
    role: "delivery",
    type: preview.type || payload.type,
    pickupAddress: preview.pickup,
    dropAddress: preview.drop,
    distanceKm: preview.distance ?? preview.distanceKm,
    earnings: preview.earnings,
    riderEarnings: preview.earnings,
    paymentMethod: preview.paymentMethod,
    collectAmount: preview.collectAmount,
    total: preview.total,
    acceptanceDeadlineAt: hasDeadline ? deadline.toISOString() : undefined,
    timeoutSeconds: hasDeadline
      ? Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000))
      : undefined,
  };
}

export function emitToCustomer(customerId, { event, payload }) {
  const s = getIo();
  if (!s || !customerId) return;
  s.to(`customer:${customerId}`).emit(event, payload);
}

/**
 * Broadcast a parcel pickup offer to every eligible parcel/both rider
 * inside the configured search radius (first accept wins).
 *
 * `zone`, when given (outstation bookings with a resolved zone — see
 * parcelWorkflowService.js), additionally confines candidates to riders
 * belonging to that zone, the same rule the local City Parcel broadcast
 * already enforces (see deliveryNearbyService.js).
 */
export async function emitParcelBroadcast(lat, lng, radiusKm, payload, { zone = null } = {}) {
  const s = getIo();
  // Parcel-only + "both" riders (isParcelService: true), online, verified.
  let ids = await getParcelRiderIdsNearPickup(lat, lng, radiusKm, { zone });

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

  const body = {
    ...payload,
    at: new Date().toISOString(),
  };

  if (s) {
    for (const id of ids) {
      s.to(`delivery:${id}`).emit("parcel:broadcast", body);
    }
  }

  if (!payload.retryAttempt) {
    emitNotificationEvent(NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST, {
      parcelId: payload.parcelId,
      deliveryIds: ids,
      data: offerPushData(payload),
    });

    try {
      await Notification.insertMany(
        ids.map((id) => ({
          recipient: new mongoose.Types.ObjectId(id),
          recipientModel: "Delivery",
          title: "New parcel delivery",
          message: `Parcel #${String(payload.parcelId || "").slice(-6)} nearby — tap Accept on the alert.`,
          type: "parcel",
          data: {
            parcelId: payload.parcelId,
            preview: payload.preview || null,
            searchExpiresAt: payload.searchExpiresAt || null,
          },
        })),
        { ordered: false },
      );
    } catch (e) {
      console.warn("[emitParcelBroadcast] notifications", e.message);
    }
  }

  return { ids };
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
