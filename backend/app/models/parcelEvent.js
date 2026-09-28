import mongoose from "mongoose";

/** Every status an outstation parcel can be in — mirrors models/parcel.js. */
export const PARCEL_STATUSES = [
  "REQUESTED",
  "SEARCHING",
  "ACCEPTED",
  "RIDER_ASSIGNED",
  "PICKUP_REACHED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
];

export const PARCEL_EVENT_ACTOR = {
  CUSTOMER: "customer",
  DELIVERY: "delivery",
  ADMIN: "admin",
  SYSTEM: "system",
};
export const PARCEL_EVENT_ACTORS = Object.values(PARCEL_EVENT_ACTOR);

/**
 * Append-only timeline for an outstation parcel.
 *
 * The pickup-service parcel model carries only a live `status` field with no
 * memory of what it was before or when it changed — a customer or admin
 * could see "PICKED_UP" but never when it was accepted, when the rider
 * showed up, or who cancelled it. This gives it an append-only timeline so
 * the booking can answer "what happened, and when".
 *
 * Written as a side effect of every status change (see
 * services/parcelEventService.js), never updated or deleted afterward.
 */
const parcelEventSchema = new mongoose.Schema(
  {
    parcelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parcel",
      required: true,
      index: true,
    },

    /** The status the parcel moved INTO. */
    status: {
      type: String,
      enum: PARCEL_STATUSES,
      required: true,
    },
    /** Where it came from. Null for the first event. */
    previousStatus: { type: String, default: null },

    actor: { type: String, enum: PARCEL_EVENT_ACTORS, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },

    at: { type: Date, default: Date.now, index: true },

    /** Short human-readable line, safe to show on the tracking screen. */
    note: { type: String, trim: true, default: "" },

    /** Anything else worth keeping: cancel reason, rider name, etc. */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: false },
);

parcelEventSchema.index({ parcelId: 1, at: 1 });

export default mongoose.model("ParcelEvent", parcelEventSchema);
