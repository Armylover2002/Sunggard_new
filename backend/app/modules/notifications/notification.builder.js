import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLES,
  ROLE_TO_RECIPIENT_MODEL,
} from "./notification.constants.js";

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
            title: (payload) => {
              const name = String(payload.userName || "Customer").trim() || "Customer";
              return `Support message from ${name}`;
            },
            body: (payload) => truncateText(payload.messageText || "New message"),
          },
          {
            role: NOTIFICATION_ROLES.CUSTOMER,
            recipientIds: (payload) => {
              const fromRole = String(payload.fromRole || "").toLowerCase();
              if (fromRole !== "admin") return [];
              return normalizeIdList(payload.userId || payload.customerId);
            },
            title: () => "Support reply",
            body: (payload) => truncateText(payload.messageText || "New message"),
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
            title: () => "Courier Request Created",
            body: (payload) =>
              payload.customerBody ||
              payload.body ||
              "Your courier request has been created.",
          },
          {
            role: NOTIFICATION_ROLES.ADMIN,
            recipientIds: (payload) => normalizeIdList(payload.adminIds),
            title: () => "New Courier Request 📦",
            body: (payload) =>
              payload.adminBody ||
              (payload.parcelId
                ? `Courier #${String(payload.parcelId).slice(-6)} booked for ₹${
                    Number(payload.fare) || 0
                  }. Tap to view.`
                : "A customer placed a new courier delivery request."),
          },
        ],
      };
    case NOTIFICATION_EVENTS.NEW_PARCEL_BROADCAST:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryIds),
        title: () => "New Courier Request 📦",
        body: (payload) =>
          payload.parcelId
            ? `Courier #${String(payload.parcelId).slice(-6)} is available nearby.`
            : "A new courier delivery request is available nearby.",
      };
    case NOTIFICATION_EVENTS.PARCEL_ASSIGNED:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryId),
        title: () => "New Courier Assigned",
        body: (payload) => payload.body || "You have been assigned a new courier delivery.",
      };
    case NOTIFICATION_EVENTS.PARCEL_SEARCH_CANCELLED:
      return {
        role: NOTIFICATION_ROLES.DELIVERY,
        recipientIds: (payload) => normalizeIdList(payload.deliveryIds),
        title: () => "Courier request no longer available",
        body: () => "This courier request was cancelled or taken by another rider.",
      };
    case NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE:
      return {
        role: NOTIFICATION_ROLES.CUSTOMER,
        recipientIds: (payload) => normalizeIdList(payload.userId || payload.customerId),
        title: () => "Courier Status Update",
        body: (payload) => payload.body || "Your courier status has been updated.",
      };
    case NOTIFICATION_EVENTS.PARCEL_DELIVERED:
      return {
        role: NOTIFICATION_ROLES.CUSTOMER,
        recipientIds: (payload) => normalizeIdList(payload.userId || payload.customerId),
        title: () => "Courier Delivered",
        body: (payload) => payload.body || "Your courier has been delivered successfully.",
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
    const title = def.title(payload);
    const body = def.body(payload);
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
