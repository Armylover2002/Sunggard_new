import admin from "firebase-admin";
import { getFirebaseAdminApp } from "../../config/firebaseAdmin.js";

const MAX_FCM_MULTICAST_TOKENS = 500;

function toStringMap(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value == null) continue;
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
      continue;
    }
    out[key] = JSON.stringify(value);
  }
  return out;
}

function chunkArray(input = [], size = MAX_FCM_MULTICAST_TOKENS) {
  const chunks = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

function getMessagingClient() {
  const app = getFirebaseAdminApp();
  if (!app) {
    const err = new Error("Firebase Admin is not configured for push notifications");
    err.code = "fcm/not-configured";
    throw err;
  }
  return admin.messaging(app);
}

function isWebLink(value = "") {
  const link = String(value || "").trim();
  return /^https?:\/\//i.test(link);
}

function resolveImageUrl(payload = {}, data = {}) {
  const fromData = String(
    data.imageUrl ||
      data.image ||
      payload?.imageUrl ||
      payload?.image ||
      "",
  ).trim();
  return isWebLink(fromData) ? fromData : "";
}

export async function sendFCM(tokens = [], payload = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      responses: [],
    };
  }

  const messaging = getMessagingClient();
  const data = toStringMap(payload.data || {});
  const link = data.link || payload?.data?.link || "";
  const resolvedLink = isWebLink(link) ? link : "";
  const title = payload.title || "";
  const body = payload.body || payload.message || "";
  const tag = data.orderId || data.eventType || "notification";
  const image = resolveImageUrl(payload, data);
  const chunks = chunkArray(tokens, MAX_FCM_MULTICAST_TOKENS);

  const merged = {
    successCount: 0,
    failureCount: 0,
    responses: [],
  };

  // Data-only: no top-level `notification`, so Android always hands the push to
  // the app's own messaging service (even backgrounded/killed) instead of the
  // OS tray. Title/body travel inside `data` so the client can still render it.
  const dataOnly = payload.dataOnly === true;
  const finalData = dataOnly
    ? { ...data, title: data.title || String(title), body: data.body || String(body) }
    : data;

  for (const chunk of chunks) {
    const result = await messaging.sendEachForMulticast({
      tokens: chunk,
      ...(dataOnly
        ? {
            // 60s matched the 30s offer window too closely — a phone that
            // was in Doze for even a few seconds around send time could miss
            // the message entirely instead of getting it late. A wider TTL
            // still expires well before any offer round does, so a late
            // delivery is never actionable, but the window to receive it at
            // all is no longer this tight.
            android: { priority: "high", ttl: 120 * 1000 },
            apns: {
              headers: { "apns-priority": "10" },
              payload: { aps: { "content-available": 1 } },
            },
          }
        : {
            // Explicit, not left to FCM's default: a notification+data
            // message is supposed to default to high on Android, but relying
            // on that default silently is how this went unnoticed.
            android: { priority: "high" },
            notification: {
              title,
              body,
              ...(image ? { image } : {}),
            },
          }),
      data: finalData,
      webpush: {
        headers: {
          Urgency: "high",
          TTL: String(60 * 60),
        },
        notification: {
          title,
          body,
          tag,
          requireInteraction: true,
          ...(image ? { image } : {}),
          data: { link: resolvedLink || link },
        },
        fcmOptions: resolvedLink ? { link: resolvedLink } : undefined,
      },
    });

    merged.successCount += Number(result.successCount || 0);
    merged.failureCount += Number(result.failureCount || 0);
    merged.responses.push(...(result.responses || []));
  }

  return merged;
}

export default {
  sendFCM,
};
