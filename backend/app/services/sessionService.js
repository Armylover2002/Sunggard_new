import PushToken from "../modules/notifications/token.model.js";
import { getIO } from "../socket/socketManager.js";

/**
 * Single active session per account, scoped strictly to that one account —
 * never across roles. A customer and a rider can share the same phone
 * number and use both apps at once; logging in to one must never touch the
 * other's session.
 *
 * Bumping sessionVersion on login invalidates any token already issued to
 * THIS SAME account (other devices, old app installs) — verifyToken rejects
 * a token whose `sv` no longer matches. The token minted right after this
 * call carries the new value, so the device that just logged in keeps
 * working.
 *
 * Pass `role` so the old devices also stop being reachable: the JWT check
 * alone does not stop push notifications (FCM tokens) or open sockets, so a
 * signed-out phone would keep getting job offers.
 */
export async function bumpOwnSession(model, id, role) {
  const updated = await model.findByIdAndUpdate(
    id,
    { $inc: { sessionVersion: 1 } },
    { new: true },
  );
  if (role) await revokeDeviceAccess(id, role);
  return updated?.sessionVersion || 0;
}

/**
 * Cuts every device of this account off from push and socket delivery.
 * Devices that are still signed in re-register their FCM token and reconnect
 * their socket with their current JWT, so only stale ones stay cut off.
 * `role` is "delivery" or "customer" — it names both the PushToken role and
 * the socket room prefix.
 */
export async function revokeDeviceAccess(id, role) {
  await PushToken.updateMany(
    { userId: id, role, isActive: true },
    { $set: { isActive: false, invalidatedAt: new Date(), invalidReason: "SESSION_REPLACED" } },
  );
  try {
    getIO().in(`${role}:${id}`).disconnectSockets(true);
  } catch {
    // Socket.IO only runs in the API process; worker/scheduler have none.
  }
}
