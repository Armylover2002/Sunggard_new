import mongoose from "mongoose";

/**
 * A customer's rating of the rider who delivered their courier.
 *
 * Separate from ParcelReview on purpose: that one rates the SERVICE (the
 * platform) and is shown publicly on the booking screen; this one rates the
 * PERSON and is shown only to that rider and to admins. Mixing them would
 * mean a customer unhappy with a price could drag down a rider, or a late
 * rider could drag down the service score.
 *
 * One per booking (unique parcelId), written once after DELIVERED.
 */

/** Quick-pick reasons, so feedback is comparable instead of free text only. */
export const RIDER_RATING_TAGS = [
  // what went well
  "polite",
  "on_time",
  "careful_with_parcel",
  "good_communication",
  // what went wrong
  "late",
  "rude",
  "careless_handling",
  "poor_communication",
];

const riderRatingSchema = new mongoose.Schema(
  {
    parcelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parcel",
      required: true,
      unique: true,
      index: true,
    },
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    tags: { type: [{ type: String, enum: RIDER_RATING_TAGS }], default: [] },
    comment: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true },
);

/** A rider's ratings, newest first — what both the rider and admin screens read. */
riderRatingSchema.index({ riderId: 1, createdAt: -1 });

export default mongoose.model("RiderRating", riderRatingSchema);
