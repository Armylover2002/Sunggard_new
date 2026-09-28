import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
        },
        title: {
            type: String,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        // How discount is applied on amount
        discountType: {
            type: String,
            enum: ["percentage", "fixed", "free_delivery"],
            default: "percentage",
        },
        discountValue: {
            type: Number,
            required: true,
        },
        maxDiscount: {
            type: Number,
        },
        // Which booking surfaces this coupon can be applied on. "order" is the
        // e-commerce product checkout (the original/only surface before Porter
        // coupons existed); "porter_local" covers Parcel bookings with
        // parcelType "local"; "porter_outstation" covers Parcel bookings with
        // parcelType "outstation". A coupon can target more than one at once
        // (e.g. both porter scopes for a single "local or outstation, same
        // dates" campaign).
        appliesTo: {
            type: [String],
            enum: ["order", "porter_local", "porter_outstation"],
            default: ["order"],
        },
        // High level coupon strategy
        couponType: {
            type: String,
            enum: [
                "bulk_order", // Bulk Order Discount – Extra discount on high-value orders
                "min_order_value", // Minimum Order Value Coupon
                "free_delivery", // Free Delivery Coupon
                "category_based", // Category-Based Coupon
                "monthly_volume", // Monthly Volume Coupon
                "generic", // Plain discount without extra conditions
            ],
            default: "generic",
        },
        // Common conditions
        minOrderValue: {
            type: Number,
            default: 0,
        },
        minItems: {
            type: Number,
            default: 0,
        },
        applicableCategories: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Category",
            },
        ],
        // Monthly volume (for future analytics‑based rules)
        monthlyVolumeThreshold: {
            type: Number,
        },
        usageLimit: {
            type: Number,
        },
        perUserLimit: {
            type: Number,
            default: 1,
        },
        usedCount: {
            type: Number,
            default: 0,
        },
        validFrom: {
            type: Date,
            required: true,
        },
        validTill: {
            type: Date,
            required: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        metadata: {
            type: Object,
        },
    },
    { timestamps: true }
);

couponSchema.index({ isActive: 1, validFrom: 1, validTill: 1 });

export default mongoose.model("Coupon", couponSchema);

