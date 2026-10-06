import { translate } from "./notification.i18n.js";
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLES,
  ROLE_TO_RECIPIENT_MODEL,
} from "./notification.constants.js";

/**
 * A translatable message: the English text is kept for the in-app list and
 * logs, and the key + vars let the sender render it in the recipient language.
 */
function msg(key, vars = {}) {
  return { key, vars, en: translate("en", key, vars) };
}

function normalizeId(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) {
    return String(value._id);
  }
  return String(value);
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeId).filter(Boolean);
  }
  const single = normalizeId(value);
  return single ? [single] : [];
}

function truncateText(text, maxLen = 140) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function getFrontendBaseUrl() {
  const explicit =
    process.env.FRONTEND_URL ||
    process.env.WEB_APP_URL ||
    "http://localhost:5173";
  return String(explicit).trim().replace(/\/+$/, "");
}

function buildCustomerSupportLink(ticketId) {
  const baseUrl = getFrontendBaseUrl();
  const id = String(ticketId || "").trim();
  return id ? `${baseUrl}/chat?ticketId=${encodeURIComponent(id)}` : `${baseUrl}/chat`;
}

function buildAdminSupportLink(ticketId) {
  const baseUrl = getFrontendBaseUrl();
  const id = String(ticketId || "").trim();
  return id
    ? `${baseUrl}/admin/support-tickets?ticketId=${encodeURIComponent(id)}`
    : `${baseUrl}/admin/support-tickets`;
}

function buildAdminParcelLink(parcelId) {
  const baseUrl = getFrontendBaseUrl();
  const id = String(parcelId || "").trim();
  return id
    ? `${baseUrl}/admin/parcels?parcelId=${encodeURIComponent(id)}`
    : `${baseUrl}/admin/parcels`;
}

function buildCustomerParcelLink(parcelId) {
  const baseUrl = getFrontendBaseUrl();
  const id = String(parcelId || "").trim();
  return id
    ? `${baseUrl}/parcel/search/${encodeURIComponent(id)}`
    : `${baseUrl}/parcel`;
}

function eventDefinition(eventType) {
  switch (eventType) {
    case NOTIFICATION_EVENTS.SUPPORT_TICKET_MESSAGE:
      return {
        multi: true,
        definitions: [
          {
            role: NOTIFICATION_ROLES.ADMIN,
            recipientIds: (payload) => {
              const fromRole = String(payload.fromRole || "").toLowerCase();
              if (fromRole === "admin") return [];
              return normalizeIdList(payload.adminIds);
            },
            title: (payload) =>
              msg("support_message_title", {
                name: String(payload.userName || "Customer").trim() || "Customer",
              }),
            body: (payload) =>
              payload.messageText
                ? truncateText(payload.messageText)
                : msg("new_message"),
          },
          {
            role: NOTIFICATION_ROLES.CUSTOMER,
            recipientIds: (payload) => {
              const fromRole = String(payload.fromRole || "").toLowerCase();
              if (fromRole !== "admin") return [];
              return normalizeIdList(payload.userId || payload.customerId);
            },
            title: () => msg("support_reply_title"),
            body: (payload) =>
              payload.messageText
                ? truncateText(payload.messageText)
                : msg("new_message"),
          },
        ],
      };
    case NOTIFICATION_EVENTS.PARCEL_REQUESTED:
      return {
        multi: true,
        definitions: [
          {
            role: NOTIFICATION_ROLES.CUSTOMER,
            recipientIds: (payload) =>
              normalizeIdList(payload.userId || payload.customerId),
            title: () => msg("parcel_request_created_title"),
            body: (payload) =>
              payload.customerBody ||
              payload.body ||
              msg("parcel_request_created_body"),
          },
          {
            role: NOTIFICATION_ROLES.ADMIN,
            recipientIds: (payload) => normalizeIdList(payload.adminIds),
            title: () => msg("parcel_new_request_title"),
            body: (payload) =>
              payload.adminBody ||
              (payload.parcelId
                ? msg("parcel_admin_booked_body", {
                    code: String(payload.parcelId).slice(-6),
                    fare: Number(payload.fare) || 0,
                  })
                : msg("parcel_admin_new_default")),
          },
        ],
      };
    case NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryIds),
        title: () => msg("parcel_new_request_title"),
        body: (payload) =>
          payload.parcelId
            ? msg("parcel_nearby_body", { code: String(payload.parcelId).slice(-6) })
            : msg("parcel_nearby_default"),
      };
    case NOTIFICATION_EVENTS.PARCEL_ASSIGNED:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryId),
        title: () => msg("parcel_assigned_title"),
        body: (payload) =>
          payload.bodyKey
            ? msg(payload.bodyKey, payload.bodyVars || {})
            : payload.body || msg("parcel_assigned_default"),
      };
    case NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryIds),
        title: () => msg("parcel_cancelled_title"),
        body: () => msg("parcel_cancelled_body"),
      };
    case NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE:
      return {
        role: NOTIFICATION_ROLES.CUSTOMER,
        recipientIds: (payload) => normalizeIdList(payload.userId || payload.customerId),
        title: (payload) => (payload.titleKey ? msg(payload.titleKey) : msg("parcel_status_title")),
        body: (payload) =>
          payload.bodyKey
            ? msg(payload.bodyKey, payload.bodyVars || {})
            : payload.body || msg("parcel_status_default"),
      };
    case NOTIFICATION_EVENTS.PARCEL_DELIVERED:
      return {
        role: NOTIFICATION_ROLES.CUSTOMER,
        recipientIds: (payload) => normalizeIdList(payload.userId || payload.customerId),
        title: () => msg("parcel_delivered_title"),
        body: (payload) =>
          payload.bodyKey
            ? msg(payload.bodyKey, payload.bodyVars || {})
            : payload.body || msg("parcel_delivered_default"),
      };

    default:
      return null;
  }
}

function eventData(eventType, payload = {}, role) {
  if (eventType === NOTIFICATION_EVENTS.SUPPORT_TICKET_MESSAGE) {
    const ticketId = String(payload.ticketId || "").trim() || undefined;
    const link =
      role === NOTIFICATION_ROLES.ADMIN
        ? buildAdminSupportLink(ticketId)
        : buildCustomerSupportLink(ticketId);

    return {
      eventType,
      ticketId,
      link,
      ...(payload.data || {}),
    };
  }
  if ([
    NOTIFICATION_EVENTS.PARCEL_REQUESTED,
    NOTIFICATION_EVENTS.PARCEL_ASSIGNED,
    NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
    NOTIFICATION_EVENTS.PARCEL_DELIVERED,
    // Without this, the broadcast fell into the generic orderId/checkoutGroupId
    // branch below and shipped no parcelId at all — the driver app's
    // IncomingParcelService looks for parcelId/outstationParcelId in the push
    // data to build the accept/reject dialog, so the offer just never appeared.
    NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST,
    NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED,
  ].includes(eventType)) {
    const parcelId = String(payload.parcelId || "").trim() || undefined;
    const link =
      role === NOTIFICATION_ROLES.ADMIN
        ? buildAdminParcelLink(parcelId)
        : buildCustomerParcelLink(parcelId);
    return {
      eventType,
      parcelId,
      outstationParcelId: parcelId,
      fare: payload.fare != null ? Number(payload.fare) : undefined,
      link,
      ...(payload.data || {}),
    };
  }

  // Every known event type is handled above (support ticket, parcel).
  // This is unreachable in practice — eventDefinition()
  // returns null for anything else, so buildNotification() never calls
  // eventData() with an unrecognized eventType.
  return { eventType, ...(payload.data || {}) };
}

export function buildNotification(eventType, payload = {}) {
  const result = eventDefinition(eventType);
  if (!result) return [];

  const definitions = result.multi ? result.definitions : [result];
  const notifications = [];

  for (const def of definitions) {
    const recipientIds = def.recipientIds(payload);
    if (!recipientIds.length) continue;

    const role = def.role;
    const titleValue = def.title(payload);
    const bodyValue = def.body(payload);
    const titleMsg = typeof titleValue === "string" ? null : titleValue;
    const bodyMsg = typeof bodyValue === "string" ? null : bodyValue;
    const title = titleMsg ? titleMsg.en : titleValue;
    const body = bodyMsg ? bodyMsg.en : bodyValue;
    const data = eventData(eventType, payload, role);

    recipientIds.forEach((recipientId) => {
      notifications.push({
        userId: recipientId,
        role,
        recipient: recipientId,
        recipientModel: ROLE_TO_RECIPIENT_MODEL[role],
        type: eventType,
        title,
        body,
        message: body,
        // Keys are used by the sender to write the text in the recipient's language.
        titleKey: titleMsg?.key,
        titleVars: titleMsg?.vars,
        bodyKey: bodyMsg?.key,
        bodyVars: bodyMsg?.vars,
        data,
        channel: "push",
        provider: "fcm",
      });
    });
  }

  return notifications;
}

export default {
  buildNotification,
};
