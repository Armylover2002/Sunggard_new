// Centralized server-side coupon engine — Porter (parcel/city-parcel)
// booking flow only. `computeBookingDiscount` validates active window,
// usage limits, and `appliesTo` scope for a delivery fare, then computes
// the discount via `applyDiscountMath` (roundCurrency-based, consistent
// rounding). `incrementCouponUsage` atomically bumps `usedCount` inside
// the booking's transaction. Callers throw HTTP errors on validation
// failure; `computeBookingDiscount` returns `null` when no coupon was
// requested — callers must treat that as "no discount" without raising.

import mongoose from "mongoose";
import Coupon from "../../models/coupon.js";
import Parcel from "../../models/parcel.js";
import { roundCurrency } from "../../utils/money.js";

const CANCELLED_PORTER_STATUSES = ["CANCELLED"];

const PORTER_BOOKING_KINDS = ["porter_local", "porter_outstation"];

function makeError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isObjectIdLike(value) {
  if (!value) return false;
  if (typeof value === "string") return mongoose.isValidObjectId(value);
  if (value._bsontype === "ObjectID" || value instanceof mongoose.Types.ObjectId) {
    return true;
  }
  return false;
}

async function loadCoupon({ couponCode, couponId, session }) {
  const query = (() => {
    if (couponId && isObjectIdLike(couponId)) {
      return Coupon.findById(couponId);
    }
    const codeValue = (couponCode || "").trim().toUpperCase();
    if (!codeValue) return null;
    return Coupon.findOne({ code: codeValue });
  })();
  if (!query) return null;
  if (session) query.session(session);
  return query.lean();
}

/**
 * The arithmetic every coupon surface shares: percentage/fixed/free_delivery
 * against a base amount, clamped by `maxDiscount`, never exceeding the base
 * amount itself. Extracted so the product-order engine and the Porter
 * booking engine can never drift apart on rounding or clamp order.
 */
function applyDiscountMath(coupon, baseAmount) {
  let discountAmount = 0;
  let freeDelivery = false;
  const couponType = String(coupon.couponType || "").toLowerCase();
  const discountType = String(coupon.discountType || "").toLowerCase();

  if (discountType === "free_delivery" || couponType === "free_delivery") {
    freeDelivery = true;
  } else if (discountType === "percentage") {
    discountAmount = roundCurrency((baseAmount * Number(coupon.discountValue || 0)) / 100);
  } else if (discountType === "fixed") {
    discountAmount = roundCurrency(Number(coupon.discountValue || 0));
  }

  if (Number.isFinite(Number(coupon.maxDiscount)) && Number(coupon.maxDiscount) > 0) {
    discountAmount = Math.min(discountAmount, Number(coupon.maxDiscount));
  }

  // Never let the coupon zero out a positive amount by accident.
  discountAmount = Math.max(0, roundCurrency(discountAmount));
  if (discountAmount > baseAmount) {
    discountAmount = baseAmount;
  }

  return { discountAmount, freeDelivery };
}

async function getPorterUserCouponUsageCount({ customerId, couponObjectId, session }) {
  if (!customerId || !couponObjectId) return 0;
  const pQuery = Parcel.countDocuments({
    customerId,
    coupon: couponObjectId,
    status: { $nin: CANCELLED_PORTER_STATUSES },
  });
  if (session) {
    pQuery.session(session);
  }
  return pQuery;
}

/**
 * Server-validated coupon discount for a Porter (parcel/city-parcel) booking.
 *
 * Mirrors `computeOrderDiscount` but works against a single `fareAmount`
 * instead of a hydrated cart, and checks `coupon.appliesTo` against
 * `bookingKind` instead of category eligibility. `minOrderValue` is reused
 * to mean "minimum fare" in this context. `free_delivery` coupons are
 * rejected here — a Porter fare has no separable delivery-fee line to zero
 * out, the whole fare *is* the delivery charge.
 *
 * @param {Object} params
 * @param {string} [params.couponCode]
 * @param {string} [params.couponId]
 * @param {string} [params.customerId]
 * @param {"porter_local"|"porter_outstation"} params.bookingKind
 * @param {number} params.fareAmount   Server-computed fare (grand total, tax included).
 * @param {*} [params.session]
 * @returns {Promise<null|{coupon:Object, discountAmount:number, payableFare:number, couponSnapshot:Object}>}
 */
export async function computeBookingDiscount({
  couponCode,
  couponId,
  customerId,
  bookingKind,
  fareAmount,
  session = null,
} = {}) {
  if (!couponCode && !couponId) return null;
  if (!PORTER_BOOKING_KINDS.includes(bookingKind)) {
    throw makeError(400, "Invalid booking type for coupon validation");
  }
  if (!(Number(fareAmount) > 0)) {
    throw makeError(400, "Cannot apply a coupon before the fare is known");
  }

  const coupon = await loadCoupon({ couponCode, couponId, session });
  if (!coupon) {
    throw makeError(404, "Invalid coupon code");
  }

  const now = new Date();
  if (
    !coupon.isActive ||
    (coupon.validFrom && new Date(coupon.validFrom) > now) ||
    (coupon.validTill && new Date(coupon.validTill) < now)
  ) {
    throw makeError(400, "This coupon is not active");
  }

  const appliesTo = Array.isArray(coupon.appliesTo) ? coupon.appliesTo : ["order"];
  if (!appliesTo.includes(bookingKind)) {
    throw makeError(400, "This coupon is not valid for this type of delivery");
  }

  if (
    String(coupon.discountType || "").toLowerCase() === "free_delivery" ||
    String(coupon.couponType || "").toLowerCase() === "free_delivery"
  ) {
    throw makeError(400, "This coupon is not valid for delivery bookings");
  }

  if (
    Number.isFinite(Number(coupon.usageLimit)) &&
    Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)
  ) {
    throw makeError(400, "This coupon has reached its usage limit");
  }

  if (customerId && Number.isFinite(Number(coupon.perUserLimit)) && Number(coupon.perUserLimit) > 0) {
    const userUsage = await getPorterUserCouponUsageCount({
      customerId,
      couponObjectId: coupon._id,
      session,
    });
    if (userUsage >= Number(coupon.perUserLimit)) {
      throw makeError(400, "You have already used this coupon");
    }
  }

  const fare = roundCurrency(Number(fareAmount));
  if (coupon.minOrderValue && fare < Number(coupon.minOrderValue)) {
    throw makeError(400, `Minimum fare should be ₹${coupon.minOrderValue}`);
  }

  const { discountAmount } = applyDiscountMath(coupon, fare);
  if (discountAmount <= 0) {
    throw makeError(400, "This coupon does not provide any discount on this fare");
  }

  const payableFare = roundCurrency(Math.max(0, fare - discountAmount));

  const couponSnapshot = {
    couponId: coupon._id,
    code: coupon.code,
    title: coupon.title || null,
    discountType: coupon.discountType || null,
    discountValue: Number(coupon.discountValue || 0),
    maxDiscount: Number.isFinite(Number(coupon.maxDiscount)) ? Number(coupon.maxDiscount) : null,
    couponType: coupon.couponType || null,
    minOrderValue: Number(coupon.minOrderValue || 0),
    perUserLimit: Number.isFinite(Number(coupon.perUserLimit)) ? Number(coupon.perUserLimit) : null,
    usageLimit: Number.isFinite(Number(coupon.usageLimit)) ? Number(coupon.usageLimit) : null,
    validFrom: coupon.validFrom || null,
    validTill: coupon.validTill || null,
    bookingKind,
    fareAtApply: fare,
    discountAmountApplied: discountAmount,
    appliedAt: new Date(),
  };

  return { coupon, discountAmount, payableFare, couponSnapshot };
}

/**
 * Atomic, usage-limit-aware increment of `Coupon.usedCount`.
 *
 * Audit fix M-3: replaces the previous fire-and-forget
 * `.updateOne(...).catch(() => {})` that ran AFTER `commitTransaction`
 * with a guarded increment that runs INSIDE the order's transaction.
 * Returns `true` on increment, `false` if the limit was already
 * reached (caller decides whether to abort the order — the order
 * placement service currently treats overflow as a soft warning to
 * preserve booking flow, mirroring legacy semantics).
 *
 * Always pass a `session`. Without a session the operation falls back
 * to a best-effort write so callers outside a transaction still work.
 */
export async function incrementCouponUsage({ couponId, session = null } = {}) {
  if (!couponId) return false;
  const updateResult = await Coupon.updateOne(
    {
      _id: couponId,
      $or: [
        { usageLimit: { $exists: false } },
        { usageLimit: null },
        { $expr: { $lt: [{ $ifNull: ["$usedCount", 0] }, "$usageLimit"] } },
      ],
    },
    { $inc: { usedCount: 1 } },
    session ? { session } : undefined,
  );
  return Number(updateResult?.modifiedCount || 0) > 0;
}

export default {
  computeBookingDiscount,
  incrementCouponUsage,
};
