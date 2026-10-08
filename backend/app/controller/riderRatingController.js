import mongoose from "mongoose";
import Parcel from "../models/parcel.js";
import Delivery from "../models/delivery.js";
import RiderRating, { RIDER_RATING_TAGS } from "../models/riderRating.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import logger from "../services/logger.js";

/**
 * Customers rating the rider who delivered their courier.
 *
 *   customer  — rate once after DELIVERED; see/skip the popup
 *   rider     — see their own overall rating and feedback
 *   admin     — see any rider's rating, how many ratings, and the feedback
 *
 * A rider's overall rating is kept on the Delivery document (rating,
 * ratingCount, ratingSum) and moved with one atomic update per new rating, so
 * showing it never means scanning every rating, and two ratings landing
 * together cannot lose one.
 */

/** The popup is only offered for recent deliveries — not one from last year. */
const PENDING_WINDOW_DAYS = 7;

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** "Vishal Patel" -> "Vishal P." — a rider never sees a customer's full name. */
function displayName(user) {
  const name = String(user?.name || "").trim();
  if (!name) return "Customer";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

const shortRef = (parcelId) => `PCL-${String(parcelId).slice(-6).toUpperCase()}`;

/** What a customer is shown about the rider they are rating. */
function riderCard(rider) {
  return {
    id: String(rider._id),
    name: rider.name || "Your rider",
    profileImage: rider.profileImage || "",
    rating: round1(rider.rating),
    ratingCount: Number(rider.ratingCount) || 0,
  };
}

/** { 5: n, 4: n, ... } for one rider, zero-filled. */
async function distributionFor(riderId) {
  const rows = await RiderRating.aggregate([
    { $match: { riderId: new mongoose.Types.ObjectId(String(riderId)) } },
    { $group: { _id: "$rating", count: { $sum: 1 } } },
  ]);
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  rows.forEach((row) => {
    distribution[row._id] = row.count;
  });
  return distribution;
}

/** The overall figure, straight from the rider document. */
const summaryFrom = (rider, distribution) => ({
  average: round1(rider.rating),
  count: Number(rider.ratingCount) || 0,
  distribution,
});

/* ==========================================================================
   Customer
   ========================================================================== */

/**
 * Has this delivery been rated, and who is the rider?
 * Drives whether the popup opens at all.
 */
export const getRiderRatingForParcel = async (req, res) => {
  try {
    const { parcelId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(parcelId)) {
      return handleResponse(res, 400, "Invalid booking");
    }

    const parcel = await Parcel.findOne({ _id: parcelId, customerId: req.user.id })
      .select("status deliveryPartnerId")
      .lean();
    if (!parcel) return handleResponse(res, 404, "Courier not found");

    const eligible = parcel.status === "DELIVERED" && Boolean(parcel.deliveryPartnerId);
    const [existing, rider] = await Promise.all([
      RiderRating.findOne({ parcelId }).lean(),
      parcel.deliveryPartnerId
        ? Delivery.findById(parcel.deliveryPartnerId)
            .select("name profileImage rating ratingCount")
            .lean()
        : null,
    ]);

    return handleResponse(res, 200, "Rider rating", {
      eligible,
      rated: Boolean(existing),
      myRating: existing
        ? { rating: existing.rating, tags: existing.tags, comment: existing.comment }
        : null,
      rider: rider ? riderCard(rider) : null,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** The latest delivered booking the customer has not rated the rider for. */
export const getPendingRiderRating = async (req, res) => {
  try {
    const since = new Date(Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const delivered = await Parcel.find({
      customerId: req.user.id,
      status: "DELIVERED",
      deliveryPartnerId: { $ne: null },
      updatedAt: { $gte: since },
    })
      .sort({ updatedAt: -1 })
      .limit(5)
      .select("_id deliveryPartnerId updatedAt")
      .lean();

    if (!delivered.length) return handleResponse(res, 200, "Nothing to rate", null);

    const rated = await RiderRating.find({ parcelId: { $in: delivered.map((p) => p._id) } })
      .select("parcelId")
      .lean();
    const ratedIds = new Set(rated.map((r) => String(r.parcelId)));
    const pending = delivered.find((p) => !ratedIds.has(String(p._id)));
    if (!pending) return handleResponse(res, 200, "Nothing to rate", null);

    const rider = await Delivery.findById(pending.deliveryPartnerId)
      .select("name profileImage rating ratingCount")
      .lean();
    if (!rider) return handleResponse(res, 200, "Nothing to rate", null);

    return handleResponse(res, 200, "Rate your rider", {
      parcelId: String(pending._id),
      reference: shortRef(pending._id),
      rider: riderCard(rider),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Rate the rider. Once per booking, only after delivery, only by its customer. */
export const submitRiderRating = async (req, res) => {
  try {
    const { parcelId, rating, comment = "", tags = [] } = req.body || {};

    if (!parcelId || !mongoose.Types.ObjectId.isValid(parcelId)) {
      return handleResponse(res, 400, "Courier ID is required");
    }
    const ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return handleResponse(res, 400, "Rating must be between 1 and 5");
    }

    const parcel = await Parcel.findById(parcelId).select("customerId status deliveryPartnerId");
    if (!parcel) return handleResponse(res, 404, "Courier not found");
    if (String(parcel.customerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You can only rate the rider on your own couriers");
    }
    if (parcel.status !== "DELIVERED") {
      return handleResponse(res, 409, "You can rate the rider only after the courier is delivered");
    }
    if (!parcel.deliveryPartnerId) {
      return handleResponse(res, 409, "This courier has no rider to rate");
    }

    const cleanTags = [...new Set(Array.isArray(tags) ? tags : [])]
      .filter((tag) => RIDER_RATING_TAGS.includes(tag))
      .slice(0, 5);
    const value = Math.round(ratingNum);

    let created;
    try {
      created = await RiderRating.create({
        parcelId,
        riderId: parcel.deliveryPartnerId,
        customerId: req.user.id,
        rating: value,
        tags: cleanTags,
        comment: String(comment || "").trim().slice(0, 500),
      });
    } catch (error) {
      // The unique parcelId index is the real "once only" guard — a double
      // tap or a second device lands here instead of counting twice.
      if (error?.code === 11000) {
        return handleResponse(res, 400, "You have already rated this rider");
      }
      throw error;
    }

    // One atomic update moves the rider's overall figure. Only runs after the
    // rating above was actually created, so a duplicate can never count twice.
    await Delivery.updateOne({ _id: parcel.deliveryPartnerId }, [
      {
        $set: {
          ratingSum: { $add: [{ $ifNull: ["$ratingSum", 0] }, value] },
          ratingCount: { $add: [{ $ifNull: ["$ratingCount", 0] }, 1] },
        },
      },
      { $set: { rating: { $round: [{ $divide: ["$ratingSum", "$ratingCount"] }, 1] } } },
    ]).catch((error) => {
      // The rating itself is saved; the average self-heals on the next one.
      logger.error("rider_rating_aggregate_update_failed", {
        riderId: String(parcel.deliveryPartnerId),
        message: error?.message,
      });
    });

    return handleResponse(res, 201, "Thanks for rating your rider!", {
      rating: created.rating,
      tags: created.tags,
      comment: created.comment,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ==========================================================================
   Rider
   ========================================================================== */

/** A rider's own overall rating, how it breaks down, and recent feedback. */
export const getMyRiderRatings = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = getPagination(req, { defaultLimit: 10, maxLimit: 50 });

    const [rider, distribution, items, total] = await Promise.all([
      Delivery.findById(riderId).select("rating ratingCount").lean(),
      distributionFor(riderId),
      RiderRating.find({ riderId })
        .populate("customerId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RiderRating.countDocuments({ riderId }),
    ]);

    return handleResponse(res, 200, "My ratings", {
      summary: summaryFrom(rider || {}, distribution),
      items: items.map((r) => ({
        id: String(r._id),
        rating: r.rating,
        tags: r.tags,
        comment: r.comment,
        customerName: displayName(r.customerId),
        reference: shortRef(r.parcelId),
        createdAt: r.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ==========================================================================
   Admin
   ========================================================================== */

/** Any rider's overall rating, how many ratings, and every piece of feedback. */
export const adminGetRiderRatings = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return handleResponse(res, 400, "Invalid rider");
    }
    const { page, limit, skip } = getPagination(req, { defaultLimit: 10, maxLimit: 100 });

    const [rider, distribution, items, total] = await Promise.all([
      Delivery.findById(id).select("name phone profileImage rating ratingCount").lean(),
      distributionFor(id),
      RiderRating.find({ riderId: id })
        .populate("customerId", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RiderRating.countDocuments({ riderId: id }),
    ]);
    if (!rider) return handleResponse(res, 404, "Rider not found");

    return handleResponse(res, 200, "Rider ratings", {
      rider: {
        id: String(rider._id),
        name: rider.name,
        phone: rider.phone,
        profileImage: rider.profileImage || "",
      },
      summary: summaryFrom(rider, distribution),
      items: items.map((r) => ({
        id: String(r._id),
        rating: r.rating,
        tags: r.tags,
        comment: r.comment,
        customerName: r.customerId?.name || "Customer",
        customerPhone: r.customerId?.phone || "",
        parcelId: String(r.parcelId),
        reference: shortRef(r.parcelId),
        createdAt: r.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
