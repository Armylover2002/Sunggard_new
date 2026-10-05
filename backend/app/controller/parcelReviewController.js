import Parcel from "../models/parcel.js";
import ParcelReview from "../models/parcelReview.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";

function displayName(user) {
  const name = String(user?.name || "").trim();
  if (!name) return "Customer";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function serializePublicReview(doc) {
  const plain = doc?.toObject ? doc.toObject() : doc;
  return {
    _id: plain._id,
    rating: plain.rating,
    comment: plain.comment || "",
    createdAt: plain.createdAt,
    customerName: displayName(plain.customerId),
  };
}

/** Customer submits rating after parcel is delivered (one per parcel). */
export const submitParcelReview = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { parcelId, rating, comment = "" } = req.body || {};

    if (!parcelId) {
      return handleResponse(res, 400, "Courier ID is required");
    }

    const ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return handleResponse(res, 400, "Rating must be between 1 and 5");
    }

    const parcel = await Parcel.findById(parcelId).select("customerId status");
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }
    if (String(parcel.customerId) !== String(customerId)) {
      return handleResponse(res, 403, "You can only review your own couriers");
    }
    if (parcel.status !== "DELIVERED") {
      return handleResponse(res, 409, "You can rate only after the courier is completed");
    }

    const existing = await ParcelReview.findOne({ parcelId });
    if (existing) {
      return handleResponse(res, 400, "You have already reviewed this courier", existing);
    }

    const review = await ParcelReview.create({
      parcelId,
      customerId,
      rating: Math.round(ratingNum),
      comment: String(comment || "").trim().slice(0, 1000),
      status: "approved",
    });

    const populated = await ParcelReview.findById(review._id)
      .populate("customerId", "name")
      .lean();

    return handleResponse(
      res,
      201,
      "Thanks for your feedback!",
      serializePublicReview(populated),
    );
  } catch (error) {
    if (error?.code === 11000) {
      return handleResponse(res, 400, "You have already reviewed this courier");
    }
    return handleResponse(res, 500, error.message);
  }
};

/** Customer's own review for a parcel (any status). */
export const getMyParcelReview = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { parcelId } = req.params;
    const review = await ParcelReview.findOne({ parcelId, customerId }).lean();
    return handleResponse(res, 200, "Courier review fetched", review || null);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Public approved reviews for parcel booking screen. */
export const listPublicParcelReviews = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 20,
      maxLimit: 50,
    });

    const query = { status: "approved" };
    const [items, total, agg] = await Promise.all([
      ParcelReview.find(query)
        .populate("customerId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ParcelReview.countDocuments(query),
      ParcelReview.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const stats = agg[0] || { avgRating: 0, count: 0 };

    return handleResponse(res, 200, "Courier reviews fetched", {
      items: items.map(serializePublicReview),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      avgRating: Math.round((Number(stats.avgRating) || 0) * 10) / 10,
      reviewCount: Number(stats.count) || 0,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Admin: all parcel reviews. */
export const adminListParcelReviews = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });
    const status = String(req.query.status || "").trim().toLowerCase();
    const query = {};
    if (["approved", "rejected", "hidden"].includes(status)) {
      query.status = status;
    }

    const [items, total] = await Promise.all([
      ParcelReview.find(query)
        .populate("customerId", "name phone email")
        .populate("parcelId", "fare status paymentMethod pickupAddress createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ParcelReview.countDocuments(query),
    ]);

    return handleResponse(res, 200, "Admin courier reviews fetched", {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Admin: hide / restore a review. */
export const adminUpdateParcelReviewStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!["approved", "rejected", "hidden"].includes(status)) {
      return handleResponse(res, 400, "Invalid status");
    }

    const review = await ParcelReview.findByIdAndUpdate(
      id,
      { status },
      { new: true },
    )
      .populate("customerId", "name phone")
      .populate("parcelId", "fare status");

    if (!review) {
      return handleResponse(res, 404, "Review not found");
    }

    return handleResponse(res, 200, `Review marked as ${status}`, review);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
