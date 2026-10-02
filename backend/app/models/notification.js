import mongoose from "mongoose";
import {
  NOTIFICATION_ROLES,
  NOTIFICATION_EVENTS,
} from "../modules/notifications/notification.constants.js";
import { ALL_USER_MODEL_NAMES_WITH_LEGACY } from "../constants/refModels.js";

const notificationSchema = new mongoose.Schema(
  {
    // New canonical fields (push + in-app unified log)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    role: {
      type: String,
      enum: Object.values(NOTIFICATION_ROLES),
      index: true,
    },
    body: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true,
    },
    sentAt: {
      type: Date,
      default: null,
      index: true,
    },
    failureReason: {
      type: String,
      default: "",
    },
    dedupeKey: {
      type: String,
      default: "",
      index: true,
    },
    channel: {
      type: String,
      enum: ["push", "in_app", "socket"],
      default: "push",
      index: true,
    },
    provider: {
      type: String,
      enum: ["fcm", "internal"],
      default: "fcm",
    },
    deliveryStats: {
      attempted: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      invalidTokens: { type: Number, default: 0 },
    },
    // Existing compatibility fields
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "recipientModel",
      index: true,
    },
    // Phase 5 P5-2: sourced from constants/refModels so the canonical
    // names ("User", "Seller", "Delivery", "Admin") and the legacy
    // alias ("Customer") stay in lock-step with the rest of the codebase
    // until the migration script rewrites every historical row.
    recipientModel: {
      type: String,
      required: true,
      enum: ALL_USER_MODEL_NAMES_WITH_LEGACY,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: [
        ...Object.values(NOTIFICATION_EVENTS),
        "order",
        "payment",
        "alert",
        "system",
        // Lightweight bookkeeping row written directly by
        // emitParcelBroadcast (not through the notify()/queue pipeline) to
        // track who currently holds a live parcel offer, so
        // retractParcelBroadcast knows who to dismiss on cancel/accept/
        // timeout. Was missing from this enum since the field was added,
        // so every one of those inserts failed Mongoose validation,
        // silently (caught and logged, never thrown) — retractParcelBroadcast's
        // query for it always matched zero rows, and no rider's stale offer
        // was ever dismissed by anything but its own client-side timer.
        "parcel",
      ],
      default: "alert",
      index: true,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

notificationSchema.pre("validate", function preValidate(next) {
  if (!this.userId && this.recipient) {
    this.userId = this.recipient;
  }
  if (!this.recipient && this.userId) {
    this.recipient = this.userId;
  }
  if (!this.body && this.message) {
    this.body = this.message;
  }
  if (!this.message && this.body) {
    this.message = this.body;
  }
  next();
});

notificationSchema.index({ recipient: 1, isRead: 1 });
notificationSchema.index({ recipient: 1, recipientModel: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ recipient: 1, recipientModel: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, role: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ userId: 1, role: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ role: 1, status: 1, createdAt: -1 });

export default mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
