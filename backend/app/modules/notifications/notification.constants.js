export const NOTIFICATION_EVENTS = Object.freeze({
  SUPPORT_TICKET_MESSAGE: "SUPPORT_TICKET_MESSAGE",
  PARCEL_REQUESTED: "PARCEL_REQUESTED",
  NEW_PARCEL_BROADCAST: "NEW_PARCEL_BROADCAST",
  PARCEL_ASSIGNED: "PARCEL_ASSIGNED",
  PARCEL_STATUS_UPDATE: "PARCEL_STATUS_UPDATE",
  PARCEL_DELIVERED: "PARCEL_DELIVERED",
  // Value is the literal string the driver app's native dismiss-handler
  // already listens for (order_cancelled) — this isn't a cosmetic name,
  // changing it would silently stop the dismiss from firing on the app side.
  PARCEL_SEARCH_CANCELLED: "order_cancelled",
});

export const NOTIFICATION_ROLES = Object.freeze({
  CUSTOMER: "customer",
  SELLER: "seller",
  DELIVERY: "delivery",
  ADMIN: "admin",
});

export const ROLE_TO_USER_MODEL = Object.freeze({
  [NOTIFICATION_ROLES.CUSTOMER]: "User",
  [NOTIFICATION_ROLES.SELLER]: "Seller",
  [NOTIFICATION_ROLES.DELIVERY]: "Delivery",
  [NOTIFICATION_ROLES.ADMIN]: "Admin",
});

export const ROLE_TO_RECIPIENT_MODEL = Object.freeze({
  [NOTIFICATION_ROLES.CUSTOMER]: "Customer",
  [NOTIFICATION_ROLES.SELLER]: "Seller",
  [NOTIFICATION_ROLES.DELIVERY]: "Delivery",
  [NOTIFICATION_ROLES.ADMIN]: "Admin",
});

export const DEFAULT_DEDUP_TTL_SECONDS = () =>
  parseInt(process.env.NOTIFICATION_DEDUP_TTL_SEC || "86400", 10);

export const NOTIFICATION_QUEUE_ATTEMPTS = () =>
  parseInt(process.env.NOTIFICATION_QUEUE_ATTEMPTS || "3", 10);

export const NOTIFICATION_QUEUE_BACKOFF_MS = () =>
  parseInt(process.env.NOTIFICATION_QUEUE_BACKOFF_MS || "2000", 10);

export const NOTIFICATION_QUEUE_CONCURRENCY = () =>
  parseInt(process.env.NOTIFICATION_QUEUE_CONCURRENCY || "20", 10);

export const NOTIFICATION_QUEUE_JOB_TIMEOUT_MS = () =>
  parseInt(process.env.NOTIFICATION_QUEUE_JOB_TIMEOUT_MS || "30000", 10);

export const NOTIFICATIONS_ENABLED = () =>
  String(process.env.PUSH_NOTIFICATIONS_ENABLED || "true").toLowerCase() !== "false";

/**
 * Rider job-offer pushes that a client may need to intercept while the app is
 * backgrounded/killed (custom overlay, alert). Only sent data-only when
 * FCM_DATA_ONLY_JOB_OFFERS=true, so the driver app must be updated first;
 * default off keeps the current notification+data behaviour.
 */
export const DATA_ONLY_EVENT_TYPES = new Set([
  NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST,
  NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED,
]);

export const isDataOnlyEvent = (eventType) =>
  String(process.env.FCM_DATA_ONLY_JOB_OFFERS || "false").toLowerCase() === "true" &&
  DATA_ONLY_EVENT_TYPES.has(eventType);

export const INVALID_FCM_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

export function normalizeNotificationRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "user") return NOTIFICATION_ROLES.CUSTOMER;
  if (value === "customer") return NOTIFICATION_ROLES.CUSTOMER;
  if (value === "seller") return NOTIFICATION_ROLES.SELLER;
  if (value === "delivery") return NOTIFICATION_ROLES.DELIVERY;
  if (value === "admin") return NOTIFICATION_ROLES.ADMIN;
  return null;
}

export function roleFromRecipientModel(recipientModel) {
  const model = String(recipientModel || "").trim().toLowerCase();
  if (model === "user" || model === "customer") return NOTIFICATION_ROLES.CUSTOMER;
  if (model === "seller") return NOTIFICATION_ROLES.SELLER;
  if (model === "delivery") return NOTIFICATION_ROLES.DELIVERY;
  if (model === "admin") return NOTIFICATION_ROLES.ADMIN;
  return null;
}

export function roleFromEvent(eventType) {
  switch (eventType) {
    case NOTIFICATION_EVENTS.PARCEL_REQUESTED:
      return NOTIFICATION_ROLES.ADMIN;
    case NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST:
    case NOTIFICATION_EVENTS.PARCEL_ASSIGNED:
    case NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED:
      return NOTIFICATION_ROLES.DELIVERY;
    default:
      return NOTIFICATION_ROLES.CUSTOMER;
  }
}
