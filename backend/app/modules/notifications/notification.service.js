import { EventEmitter } from "events";
import Notification from "./notification.model.js";
import NotificationPreference from "./preference.model.js";
import { buildNotification } from "./notification.builder.js";
import {
  DEFAULT_DEDUP_TTL_SECONDS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLES,
  NOTIFICATIONS_ENABLED,
} from "./notification.constants.js";
import { getRedisClient, isBullMQEnabled } from "../../config/redis.js";
import logger from "../../services/logger.js";
import { incrementCounter, setGauge } from "../../services/metrics.js";
import { deliverNotificationById } from "./notification.worker.js";
import { translate } from "./notification.i18n.js";
import { getUserLanguage } from "./notification.language.js";
import {
  notificationQueue,
  NOTIFICATION_JOB_NAMES,
} from "./notification.queue.js";
import {
  emitToAdmin,
  emitToSeller,
  emitToCustomer,
  emitToDelivery,
} from "../../services/orderSocketEmitter.js";

const notificationEmitter = new EventEmitter();
const localDedupeStore = new Map();
let listenerRegistered = false;

function dedupeKeyForNotification(eventType, notification, payload = {}) {
  // An outstation parcel's PARCEL_STATUS_UPDATE
  // fires once per lifecycle step (ACCEPTED, RIDER_ASSIGNED, PICKUP_REACHED,
  // PICKED_UP...), all under the same eventType. Without status in the key, only
  // the first status change ever got a key claim; every later one this parcel
  // ever has was a permanent "duplicate" for the rest of the dedupe TTL.
  if (payload.parcelId) {
    return [
      "notify",
      String(eventType || "UNKNOWN"),
      String(notification?.role || "unknown"),
      String(notification?.userId || "unknown"),
      String(payload.parcelId),
      String(payload.status || payload.data?.status || notification?.data?.status || ""),
    ].join(":");
  }

  const orderRef =
    payload.messageId ||
    payload.messageCreatedAt ||
    payload.ticketId ||
    payload.parcelId ||
    payload.orderId ||
    payload.productId ||
    payload.variantSku ||
    notification?.data?.parcelId ||
    notification?.data?.orderId ||
    notification?.data?.productId ||
    notification?.data?.variantSku ||
    payload.checkoutGroupId ||
    payload.userId ||
    notification?.userId ||
    "unknown";
  return [
    "notify",
    String(eventType || "UNKNOWN"),
    String(notification?.role || "unknown"),
    String(notification?.userId || "unknown"),
    String(orderRef || "unknown"),
  ].join(":");
}

function cleanLocalDedupeStore(now = Date.now()) {
  for (const [key, expiresAt] of localDedupeStore.entries()) {
    if (expiresAt <= now) {
      localDedupeStore.delete(key);
    }
  }
}

async function claimDedupeKey(key, ttlSeconds) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
      return result === "OK";
    } catch (error) {
      logger.warn("Redis dedupe check failed, falling back to local dedupe", {
        message: error.message,
      });
    }
  }

  const now = Date.now();
  cleanLocalDedupeStore(now);
  const existingExpiry = localDedupeStore.get(key);
  if (existingExpiry && existingExpiry > now) {
    return false;
  }
  localDedupeStore.set(key, now + ttlSeconds * 1000);
  return true;
}

// "Order updates" -> booking/customer-facing parcel status updates.
function isOrderUpdateEvent(eventType) {
  return [
    NOTIFICATION_EVENTS.PARCEL_REQUESTED,
    NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
    NOTIFICATION_EVENTS.PARCEL_DELIVERED,
  ].includes(eventType);
}

// "Delivery updates" -> rider-facing job offers/assignments.
function isDeliveryUpdateEvent(eventType) {
  return [
    NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST,
    NOTIFICATION_EVENTS.PARCEL_ASSIGNED,
  ].includes(eventType);
}

async function getPreference(userId, role) {
  return NotificationPreference.findOneAndUpdate(
    {
      userId,
      role,
    },
    {
      $setOnInsert: {
        userId,
        role,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  ).lean();
}

function isAllowedByPreference(eventType, preference) {
  if (!preference) return true;
  if (isDeliveryUpdateEvent(eventType)) {
    return preference.deliveryUpdates !== false;
  }
  if (isOrderUpdateEvent(eventType)) {
    return preference.orderUpdates !== false;
  }
  return true;
}

async function refreshQueueMetrics() {
  setGauge("notifications_queue_size", 0);
  setGauge("notifications_queue_waiting", 0);
  setGauge("notifications_queue_active", 0);
  setGauge("notifications_queue_failed", 0);
}

/**
 * Push an in-app `notification:new` delta to the recipient's role
 * room so the UI (topbar badge, NotificationPopup) can refresh
 * instantly. Fire-and-forget — if the socket layer is unavailable or
 * the recipient has no live client, we just skip silently. The
 * Notification row is already persisted, so the standard refetch /
 * poll fallback still surfaces it.
 *
 * Payload is intentionally small: clients should treat this as a
 * "ping, go refetch your notifications" rather than a full mirror of
 * the row (which avoids drift if the DB write is later corrected).
 */
function emitInAppNotificationDelta(notification, notificationDoc, eventType) {
  try {
    const userId =
      notificationDoc?.userId != null &&
      typeof notificationDoc.userId.toString === "function"
        ? notificationDoc.userId.toString()
        : String(notificationDoc?.userId || notification?.userId || "");
    if (!userId) return;

    const payload = {
      notificationId: notificationDoc?._id?.toString?.() || null,
      eventType: eventType || notificationDoc?.type || notification?.type,
      role: notification.role,
      title: notification.title,
      body: notification.body || notification.message,
      data: notification.data || {},
      createdAt:
        (notificationDoc?.createdAt instanceof Date
          ? notificationDoc.createdAt.toISOString()
          : null) || new Date().toISOString(),
    };

    switch (notification.role) {
      case NOTIFICATION_ROLES.ADMIN:
        emitToAdmin(userId, { event: "notification:new", payload });
        break;
      case NOTIFICATION_ROLES.SELLER:
        emitToSeller(userId, { event: "notification:new", payload });
        break;
      case NOTIFICATION_ROLES.CUSTOMER:
        emitToCustomer(userId, { event: "notification:new", payload });
        break;
      case NOTIFICATION_ROLES.DELIVERY:
        emitToDelivery(userId, { event: "notification:new", payload });
        break;
      default:
        // Unknown role — nothing to do. Push pipeline still handles it.
        break;
    }
  } catch (error) {
    // Never let an in-app emit issue derail the rest of the pipeline.
    logger.warn("In-app notification socket emit failed", {
      role: notification?.role,
      message: error?.message,
    });
  }
}

/**
 * Renders a notification's title and body in the recipient's language. A
 * message without a translation key (e.g. chat text) is sent as written.
 */
async function localizeForRecipient(raw) {
  const lang = await getUserLanguage(raw.userId, raw.role);
  const { titleKey, titleVars, bodyKey, bodyVars, ...rest } = raw;
  const title = titleKey ? translate(lang, titleKey, titleVars) : raw.title;
  const body = bodyKey ? translate(lang, bodyKey, bodyVars) : raw.body;
  // The push client reads title/body from `data` first, so the copies there
  // must carry the translated text too, not the English the caller passed.
  const data = rest.data ? { ...rest.data, title, body } : rest.data;
  return { ...rest, title, body, message: body, ...(data ? { data } : {}) };
}

export async function notify(eventType, payload = {}) {
  if (!NOTIFICATIONS_ENABLED()) {
    return { enqueued: 0, skipped: 0, duplicates: 0, notificationIds: [] };
  }

  const notifications = buildNotification(eventType, payload);
  if (!notifications.length) {
    return { enqueued: 0, skipped: 0, duplicates: 0, notificationIds: [] };
  }

  const dedupeTtlSeconds = DEFAULT_DEDUP_TTL_SECONDS();
  let enqueued = 0;
  let skipped = 0;
  let duplicates = 0;
  const notificationIds = [];

  for (const rawNotification of notifications) {
    // Text is written in the recipient's chosen language (English by default).
    const notification = await localizeForRecipient(rawNotification);
    try {
      const preference = await getPreference(notification.userId, notification.role);
      if (!isAllowedByPreference(eventType, preference)) {
        skipped += 1;
        continue;
      }

      const dedupeKey = dedupeKeyForNotification(eventType, notification, payload);
      const isFirstOccurrence = await claimDedupeKey(dedupeKey, dedupeTtlSeconds);
      if (!isFirstOccurrence) {
        duplicates += 1;
        incrementCounter("notifications_duplicates_total", {
          eventType,
          role: notification.role,
        });
        continue;
      }

      // A repeating offer (the same rider offered the same courier again on a
      // later round) replaces its earlier row so the in-app list shows it once.
      // The push for this round is unaffected — it is sent below either way.
      if (payload.replacePrevious && payload.parcelId) {
        await Notification.deleteMany({
          userId: notification.userId,
          role: notification.role,
          type: notification.type,
          "data.parcelId": String(payload.parcelId),
        }).catch((error) => {
          logger.warn("Could not clear the previous round's notification", {
            eventType,
            message: error?.message,
          });
        });
      }

      const notificationDoc = await Notification.create({
        ...notification,
        dedupeKey,
        status: "pending",
      });

      // In-app socket delta — wake up any open admin/seller/customer/
      // delivery UI immediately so their topbar badge increments without
      // waiting on FCM or the 20 s poll fallback. Best-effort: a missing
      // socket layer must never block notification creation. Runs BEFORE
      // the push enqueue so even a Bull/Redis outage doesn't suppress
      // the in-app signal.
      emitInAppNotificationDelta(notification, notificationDoc, eventType);

      // Push pipeline is queue-first: the API/event handler only persists
      // the Notification row and hands off delivery to the worker via Bull.
      // This keeps HTTP/event paths fast and lets Bull's retry / dead-letter
      // / concurrency controls actually do their job. When Redis is
      // disabled (e.g. local dev / tests) we fall back to the legacy inline
      // call so behaviour is preserved end-to-end.
      const notificationIdStr = notificationDoc._id.toString();
      const useQueue = isBullMQEnabled();

      try {
        if (useQueue) {
          await notificationQueue.add(
            NOTIFICATION_JOB_NAMES.SEND,
            { notificationId: notificationIdStr },
          );
          enqueued += 1;
          notificationIds.push(notificationIdStr);
          incrementCounter("notifications_total", {
            status: "queued",
            eventType,
            role: notification.role,
          });
        } else {
          await deliverNotificationById(notificationIdStr);
          enqueued += 1;
          notificationIds.push(notificationIdStr);
          incrementCounter("notifications_total", {
            status: "triggered",
            eventType,
            role: notification.role,
          });
        }
      } catch (deliveryError) {
        await Notification.updateOne(
          { _id: notificationDoc._id },
          {
            $set: {
              status: "failed",
              failureReason: deliveryError.message,
            },
          },
        );
        incrementCounter("notifications_total", {
          status: "failed",
          eventType,
          role: notification.role,
        });
        logger.error(
          useQueue
            ? "Failed to enqueue notification for delivery"
            : "Failed to deliver notification",
          {
            notificationId: notificationIdStr,
            eventType,
            message: deliveryError.message,
          },
        );
      }
    } catch (error) {
      skipped += 1;
      logger.error("Notification emit pipeline failed", {
        eventType,
        message: error.message,
      });
    }
  }

  await refreshQueueMetrics();
  return { enqueued, skipped, duplicates, notificationIds };
}

function registerNotificationListener() {
  if (listenerRegistered) return;
  notificationEmitter.on("notification:event", ({ eventType, payload }) => {
    notify(eventType, payload).catch((error) => {
      logger.error("Notification listener failed", {
        eventType,
        message: error.message,
      });
    });
  });
  listenerRegistered = true;
}

registerNotificationListener();

export function emitNotificationEvent(eventType, payload = {}) {
  setImmediate(() => {
    notificationEmitter.emit("notification:event", {
      eventType,
      payload,
    });
  });
}

export function emitCustomerNotification(eventType, payload = {}) {
  emitNotificationEvent(eventType, {
    ...payload,
    role: NOTIFICATION_ROLES.CUSTOMER,
  });
}

export function emitSellerNotification(eventType, payload = {}) {
  emitNotificationEvent(eventType, {
    ...payload,
    role: NOTIFICATION_ROLES.SELLER,
  });
}

export function emitDeliveryNotification(eventType, payload = {}) {
  emitNotificationEvent(eventType, {
    ...payload,
    role: NOTIFICATION_ROLES.DELIVERY,
  });
}

export default {
  notify,
  emitNotificationEvent,
  emitCustomerNotification,
  emitSellerNotification,
  emitDeliveryNotification,
};
