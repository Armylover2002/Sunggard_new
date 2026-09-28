import mongoose from "mongoose";
import {
    ALL_DELIVERY_PRICING_MODES,
    ALL_HANDLING_FEE_STRATEGIES,
} from "../constants/finance.js";

const settingSchema = new mongoose.Schema(
    {
        // General
        appName: {
            type: String,
            default: "Appzeto Porter",
        },
        supportEmail: {
            type: String,
            default: "support@appzeto.com",
        },
        supportPhone: {
            type: String,
            default: "",
        },
        currencySymbol: {
            type: String,
            default: "₹",
        },
        currencyCode: {
            type: String,
            default: "INR",
        },
        timezone: {
            type: String,
            default: "Asia/Kolkata",
        },

        // Branding
        logoUrl: String,
        faviconUrl: String,
        primaryColor: {
            type: String,
            default: "#0C831F",
        },
        secondaryColor: {
            type: String,
            default: "#64748b",
        },

        // Legal
        companyName: String,
        taxId: String,
        address: String,

        // Social
        facebook: String,
        twitter: String,
        instagram: String,
        linkedin: String,
        youtube: String,

        // Apps
        playStoreLink: String,
        appStoreLink: String,

        // SEO
        metaTitle: String,
        metaDescription: String,
        metaKeywords: String,
        keywords: [{ type: String }], // Array for structured SEO keywords

        // Optional: multi-tenant (null = default tenant)
        tenantId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        // Returns / logistics configuration
        returnDeliveryCommission: {
            // Flat amount per return pickup, paid by seller
            type: Number,
            default: 0,
        },

        /**
         * Finance / delivery pricing rules (single source of truth).
         * Existing keys are kept for backward compatibility.
         */
        deliveryPricingMode: {
            type: String,
            enum: ALL_DELIVERY_PRICING_MODES,
            default: "distance_based",
        },
        pricingMode: {
            type: String,
            enum: ALL_DELIVERY_PRICING_MODES,
            default: "distance_based",
        },
        customerBaseDeliveryFee: {
            type: Number,
            default: 30,
            min: 0,
        },
        riderBasePayout: {
            type: Number,
            default: 30,
            min: 0,
        },
        baseDeliveryCharge: {
            type: Number,
            default: 30,
            min: 0,
        },
        baseDistanceCapacityKm: {
            type: Number,
            default: 0.5,
            min: 0,
        },
        incrementalKmSurcharge: {
            type: Number,
            default: 10,
            min: 0,
        },
        deliveryPartnerRatePerKm: {
            type: Number,
            default: 5,
            min: 0,
        },
        fleetCommissionRatePerKm: {
            type: Number,
            default: 5,
            min: 0,
        },
        fixedDeliveryFee: {
            type: Number,
            default: 30,
            min: 0,
        },
        handlingFeeStrategy: {
            type: String,
            enum: ALL_HANDLING_FEE_STRATEGIES,
            default: "highest_category_fee",
        },
        codEnabled: {
            type: Boolean,
            default: true,
        },
        onlineEnabled: {
            type: Boolean,
            default: true,
        },
        /**
         * COD cash policy for the porter fleet.
         *
         * The admin cash screen used to aggregate `{ $ifNull: ["$limit", 5000] }`
         * over the Delivery collection. `limit` was never a field on that
         * model, so every rider read as having a ₹5,000 limit, nothing could
         * change it, and nothing enforced it — the number on screen was
         * decoration. These are the real settings, resolved (together with the
         * per-rider `Delivery.cashLimit` override) by
         * services/porter/riderCashLimitService.js.
         */
        porterCash: {
            /**
             * Off by default. Turning enforcement on stops work reaching every
             * rider already over the limit, the moment it flips — that has to
             * be a deliberate act, never a field that defaulted to true on a
             * deploy.
             */
            enforceCashLimit: { type: Boolean, default: false },
            /** Fleet-wide default, used by any rider with no own override. */
            globalCashLimit: { type: Number, default: 5000, min: 0 },
            /** Share of the limit at which the rider app starts warning them. */
            warnAtPercent: { type: Number, default: 80, min: 0, max: 100 },
            /**
             * Whether an APPROVED deposit is required before work resumes, or
             * a raised one is enough. True is the business rule as stated;
             * false exists for an operation that trusts its riders and wants
             * the block lifted the moment they pay.
             */
            requireApprovalToResume: { type: Boolean, default: true },
        },

        /**
         * @deprecated Superseded by the online rider deposit flow.
         *
         * A rider used to be shown an admin-configured UPI ID / QR / bank
         * account, transfer to it out of band, and upload a screenshot for an
         * admin to eyeball. That is a manual reconciliation step for every
         * deposit and it proves nothing — a screenshot is not a payment.
         *
         * Deposits now go through the gateway (see
         * services/porter/riderDepositService.js), so the destination is the
         * platform's own Razorpay account and there is nothing to configure.
         * The field is retained so historical deposits still render, and so a
         * deployment can fall back if the gateway is unavailable.
         */
        cashDepositPayout: {
            upiId: { type: String, trim: true, default: "" },
            qrImageUrl: { type: String, trim: true, default: "" },
            bankAccountHolder: { type: String, trim: true, default: "" },
            bankAccountNumber: { type: String, trim: true, default: "" },
            bankIfsc: { type: String, trim: true, default: "" },
            bankName: { type: String, trim: true, default: "" },
        },

        /**
         * Admin-managed legal / informational content.
         * Stored as HTML strings (set via the admin settings panel).
         * Each field has a separate version for customer-facing and
         * delivery-boy-facing apps so content can be tailored per audience.
         *
         * Empty string means "use the static fallback built into the frontend".
         */
        legalContent: {
            // Customer app
            customerPrivacyPolicy: { type: String, default: "" },
            customerTerms:         { type: String, default: "" },
            customerAboutUs:       { type: String, default: "" },
            // Delivery-boy app
            deliveryPrivacyPolicy: { type: String, default: "" },
            deliveryTerms:         { type: String, default: "" },
            deliveryAboutUs:       { type: String, default: "" },
        },
    },
    {
        timestamps: true,
    }
);

settingSchema.pre("save", function syncFinanceAliases(next) {
    if (!this.pricingMode && this.deliveryPricingMode) {
        this.pricingMode = this.deliveryPricingMode;
    }
    if (!this.deliveryPricingMode && this.pricingMode) {
        this.deliveryPricingMode = this.pricingMode;
    }

    if (this.baseDeliveryCharge == null) {
        this.baseDeliveryCharge = this.customerBaseDeliveryFee ?? 30;
    }
    if (this.customerBaseDeliveryFee == null) {
        this.customerBaseDeliveryFee = this.baseDeliveryCharge ?? 30;
    }

    if (this.riderBasePayout == null) {
        this.riderBasePayout = this.baseDeliveryCharge ?? this.customerBaseDeliveryFee ?? 30;
    }

    if (this.fleetCommissionRatePerKm == null && this.deliveryPartnerRatePerKm != null) {
        this.fleetCommissionRatePerKm = this.deliveryPartnerRatePerKm;
    }
    if (this.deliveryPartnerRatePerKm == null && this.fleetCommissionRatePerKm != null) {
        this.deliveryPartnerRatePerKm = this.fleetCommissionRatePerKm;
    }

    if (this.fixedDeliveryFee == null) {
        this.fixedDeliveryFee = this.baseDeliveryCharge ?? this.customerBaseDeliveryFee ?? 30;
    }

    next();
});

export default mongoose.model("Setting", settingSchema);
