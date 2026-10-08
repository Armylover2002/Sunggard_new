/**
 * Socket.IO — order rooms, role rooms, JWT auth.
 */
import { verifySocketToken } from "./socketAuth.js";
import mongoose from "mongoose";
import Ticket from "../models/ticket.js";
import Delivery from "../models/delivery.js";

let _io = null;

const deliverySockets = new Map();

/**
 * A rider's app closing, losing network, or crashing never calls the "go
 * offline" API — the socket just drops. Without this, `isOnline` in the
 * database stays whatever it last was (often still `true`), so dispatch
 * kept offering jobs to a rider who was never going to see them. A short
 * grace period (rather than flipping offline the instant the socket drops)
 * tolerates an ordinary reconnect blip — a brief mobile-network gap, an app
 * resume — without bouncing availability for it.
 */
const DELIVERY_OFFLINE_GRACE_MS = parseInt(
  process.env.DELIVERY_OFFLINE_GRACE_MS || "20000",
  10,
);
const deliveryOfflineTimers = new Map();
const AUTO_OFFLINE_ON_DISCONNECT =
  String(process.env.DELIVERY_AUTO_OFFLINE_ON_DISCONNECT || "").toLowerCase() === "true";

export const initSocket = (io) => {
  _io = io;

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      null;
    if (!token) {
      socket.user = null;
      return next();
    }
    const user = verifySocketToken(token);
    if (!user) {
      return next(new Error("Unauthorized"));
    }
    socket.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const { id: userId, role } = socket.user || {};
    if (!userId) {
      return;
    }

    if (role === "delivery") {
      const dId = userId.toString();
      deliverySockets.set(dId, socket.id);
      socket.join(`delivery:${dId}`);
      // Reconnected within the grace window (or opened a second tab/device)
      // — cancel any pending offline flip from an earlier disconnect.
      const pendingOfflineTimer = deliveryOfflineTimers.get(dId);
      if (pendingOfflineTimer) {
        clearTimeout(pendingOfflineTimer);
        deliveryOfflineTimers.delete(dId);
      }
      Delivery.findById(dId).select("isVerified").lean().then((partner) => {
        if (partner?.isVerified) {
          socket.join("delivery:online");
        }
      }).catch(() => {});
    }
    if (role === "seller") {
      socket.join(`seller:${userId}`);
    }
    if (role === "customer" || role === "user") {
      socket.join(`customer:${userId}`);
    }
    if (role === "admin") {
      socket.join("admin:orders");
      socket.join("admin:support");
      // Per-admin room — used by the notification service to push
      // `notification:new` deltas to the specific admin who owns the
      // Notification row, so the topbar can refresh without polling.
      socket.join(`admin:${userId}`);
    }

    socket.on("join_order", (orderId) => {
      if (!orderId || typeof orderId !== "string") return;
      socket.join(`order:${orderId}`);
    });

    socket.on("leave_order", (orderId) => {
      if (!orderId) return;
      socket.leave(`order:${orderId}`);
    });

    socket.on("join_ticket", async (ticketId) => {
      const raw = typeof ticketId === "string" ? ticketId.trim() : "";
      if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return;

      if (socket.user?.role === "admin") {
        socket.join(`ticket:${raw}`);
        return;
      }

      try {
        const ticket = await Ticket.findById(raw).select("userId").lean();
        if (!ticket?.userId) return;
        if (ticket.userId.toString() !== userId.toString()) return;
        socket.join(`ticket:${raw}`);
      } catch {
        /* ignore */
      }
    });

    socket.on("leave_ticket", (ticketId) => {
      if (!ticketId) return;
      socket.leave(`ticket:${String(ticketId).trim()}`);
    });

    socket.on("register_delivery", (deliveryId) => {
      if (deliveryId && socket.user?.role === "delivery") {
        deliverySockets.set(deliveryId.toString(), socket.id);
      }
    });

    socket.on("disconnect", () => {
      for (const [id, sid] of deliverySockets.entries()) {
        if (sid === socket.id) {
          deliverySockets.delete(id);

          // Closing the app or going idle must NOT take a rider offline: they
          // still receive job offers as push notifications with the app
          // closed, and an unexpected "you are offline" is the bug this
          // switch removes. A rider is offline only when they choose to be
          // (or an admin deactivates them). The old behaviour is still
          // available with DELIVERY_AUTO_OFFLINE_ON_DISCONNECT=true.
          if (!AUTO_OFFLINE_ON_DISCONNECT) break;

          // Give them DELIVERY_OFFLINE_GRACE_MS to reconnect (a dropped
          // socket is usually a blip, not a real go-offline) before actually
          // marking them unavailable for new offers. A second connect from
          // the same rider within the window cancels this via the handler
          // above instead of racing it.
          const timer = setTimeout(async () => {
            deliveryOfflineTimers.delete(id);
            if (deliverySockets.has(id)) return; // reconnected since
            try {
              await Delivery.updateOne(
                { _id: id, isOnline: true },
                { $set: { isOnline: false } },
              );
            } catch (err) {
              console.warn("[socketManager] offline-grace flip failed", id, err.message);
            }
          }, DELIVERY_OFFLINE_GRACE_MS);
          deliveryOfflineTimers.set(id, timer);
          break;
        }
      }
    });
  });
};

export const getIO = () => {
  if (!_io) throw new Error("Socket.IO not initialized");
  return _io;
};

export const notifyDeliveryPartners = (orderData) => {
  if (!_io) return;
  _io.to("delivery:online").emit("new_order_packed", orderData);
};
