import Coupon from "../models/coupon.js";
import handleResponse from "../utils/helper.js";
import { buildSearchRegex } from "../utils/regex.js";

const PORTER_SCOPES = ["porter_local", "porter_outstation"];

// A delivery fare has no line items or product categories, so only these
// two strategies mean anything for a porter-only coupon — the rest
// (bulk_order/category_based/monthly_volume) have no implementation in
// `computeBookingDiscount` and would silently do nothing; `free_delivery`
// is actively broken there (see couponService.js), so it's rejected outright.
const PORTER_ALLOWED_COUPON_TYPES = ["generic", "min_order_value"];

/**
 * Shared create/update guard: validity window sanity and the
 * porter/free_delivery incompatibility. Returns an error message string, or
 * `null` when the payload is fine. `isCreate` gates the "start date can't be
 * in the past" rule — an admin editing an already-running coupon should
 * still be able to save it.
 */
function validateCouponPayload(data, { isCreate }) {
    if (data.validFrom !== undefined && data.validTill !== undefined) {
        const from = new Date(data.validFrom);
        const till = new Date(data.validTill);
        if (Number.isNaN(from.getTime()) || Number.isNaN(till.getTime())) {
            return "Please provide valid start and end dates";
        }
        if (till <= from) {
            return "End date must be after the start date";
        }
        if (isCreate) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            if (from < todayStart) {
                return "Start date cannot be in the past";
            }
        }
    }

    if (data.appliesTo !== undefined) {
        const appliesTo = Array.isArray(data.appliesTo) ? data.appliesTo : [];
        if (appliesTo.length === 0) {
            return "Select at least one coupon scope";
        }
        // This deployment runs Porter delivery only — no product-order coupon
        // flow is created here. Gated on `isCreate` so an editor is never
        // blocked from fixing/expiring a pre-existing order coupon that
        // predates this restriction; only NEW order-scoped coupons are
        // refused.
        if (isCreate && appliesTo.includes("order")) {
            return "This admin only creates delivery (local/courier) coupons — product-order coupons aren't supported here";
        }
        const hasPorterScope = appliesTo.some((scope) => PORTER_SCOPES.includes(scope));
        const couponType = String(data.couponType || "generic").toLowerCase();
        if (hasPorterScope) {
            if (String(data.discountType || "").toLowerCase() === "free_delivery" || couponType === "free_delivery") {
                return "Free delivery coupons cannot be used for local/courier delivery bookings";
            }
            const porterOnly = !appliesTo.includes("order");
            if (porterOnly && data.couponType !== undefined && !PORTER_ALLOWED_COUPON_TYPES.includes(couponType)) {
                return "This coupon strategy needs product categories/order history, which a delivery booking doesn't have — use Generic or Minimum Fare instead";
            }
        }
    }

    return null;
}

export const listCoupons = async (req, res) => {
    try {
        const { status, search } = req.query;
        const query = {};

        if (status === "active") {
            const now = new Date();
            query.isActive = true;
            query.validFrom = { $lte: now };
            query.validTill = { $gte: now };
        } else if (status === "expired") {
            query.$or = [{ isActive: false }, { validTill: { $lt: new Date() } }];
        }

        if (search) {
            const term = search.trim();
            // P3-5: substring search preserved; user input is regex-escaped.
            const safe = buildSearchRegex(term, { anchored: false });
            query.$or = [
                { code: safe },
                { title: safe },
                { description: safe },
            ];
        }

        const coupons = await Coupon.find(query).sort({ createdAt: -1 }).lean();
        return handleResponse(res, 200, "Coupons fetched successfully", coupons);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const createCoupon = async (req, res) => {
    try {
        const data = { ...req.body };
        // The model's own schema default (`["order"]`) predates the Porter
        // scope and would silently create a product-order coupon for any
        // caller that omits `appliesTo` — this admin never intends that, so
        // an omitted scope defaults to Porter here instead.
        // LOCAL CITY PARCEL DISABLED — default is outstation-only now.
        if (data.appliesTo === undefined) {
            data.appliesTo = ["porter_outstation"];
        }
        const validationError = validateCouponPayload(data, { isCreate: true });
        if (validationError) {
            return handleResponse(res, 400, validationError);
        }
        const coupon = await Coupon.create(data);
        return handleResponse(res, 201, "Coupon created successfully", coupon);
    } catch (error) {
        if (error.code === 11000) {
            return handleResponse(res, 400, "Coupon code already exists");
        }
        return handleResponse(res, 500, error.message);
    }
};

export const updateCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const data = { ...req.body };
        const validationError = validateCouponPayload(data, { isCreate: false });
        if (validationError) {
            return handleResponse(res, 400, validationError);
        }
        const coupon = await Coupon.findByIdAndUpdate(id, data, {
            new: true,
            runValidators: true,
        });
        if (!coupon) {
            return handleResponse(res, 404, "Coupon not found");
        }
        return handleResponse(res, 200, "Coupon updated successfully", coupon);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const deleteCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        await Coupon.findByIdAndDelete(id);
        return handleResponse(res, 200, "Coupon deleted successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

