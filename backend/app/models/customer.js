import mongoose from "mongoose";
import { normalizePhoneNumber } from "../utils/phone.js";

const addressSchema = new mongoose.Schema({
    label: {
        type: String,
        enum: ["home", "work", "other"],
        default: "home",
    },
    fullAddress: {
        type: String,
        required: true,
    },
    formattedAddress: String,
    placeId: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    location: {
        lat: Number,
        lng: Number,
    },
});

const userSchema = new mongoose.Schema(
    {
    language: {
        type: String,
        default: "en",
        trim: true,
        lowercase: true,
    },
        name: {
            type: String,
            trim: true,
            maxlength: [50, "Name cannot exceed 50 characters"],
        },

        email: {
            type: String,
            lowercase: true,
            unique: true,
            sparse: true, // phone login users ke liye
        },

        avatar: {
            type: String,
            default: "",
            trim: true,
        },

        /**
         * Bumped when the same phone number logs in as the other role, which
         * signs that role out everywhere (see services/sessionService.js).
         */
        sessionVersion: {
            type: Number,
            default: 0,
        },

        phone: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },

        password: {
            type: String,
            select: false, // response me password na aaye
        },

        role: {
            type: String,
            enum: ["user", "admin", "delivery", "seller"],
            default: "user",
        },

        isVerified: {
            type: Boolean,
            default: false,
        },

        otp: {
            type: String,
            select: false,
        },

        otpExpiry: {
            type: Date,
            select: false,
        },

        otpHash: {
            type: String,
            select: false,
        },

        otpExpiresAt: {
            type: Date,
            select: false,
        },

        otpFailedAttempts: {
            type: Number,
            default: 0,
            select: false,
        },

        otpLockedUntil: {
            type: Date,
            select: false,
        },

        otpLastSentAt: {
            type: Date,
            select: false,
        },

        otpSessionVersion: {
            type: Number,
            default: 0,
            select: false,
        },

        addresses: [addressSchema],

        /**
         * The customer's own money trail, denormalised onto their document.
         *
         * Deliberately CAPPED (see `pushCustomerTransaction` in
         * services/porter/customerLedgerService.js, which writes it with
         * `$slice`). An uncapped array on a user document is a document that
         * grows without bound until a heavy user's profile stops loading —
         * the canonical, complete history lives in the `PorterPayment` and
         * `Transaction` collections, which are indexed and paginated.
         *
         * What this array is for is the "recent activity" strip every app
         * screen wants without a second round trip, and being able to answer
         * "what has this customer paid us" from the one document support
         * already has open.
         */
        transactions: {
            type: [
                new mongoose.Schema(
                    {
                        /** PorterPayment / Payment / Transaction row this mirrors. */
                        refId: { type: mongoose.Schema.Types.ObjectId, default: null },
                        /** Which collection `refId` points into. */
                        refModel: {
                            type: String,
                            enum: ["PorterPayment", "Payment", "Transaction", ""],
                            default: "",
                        },
                        /** PAYMENT | REFUND | COD | WALLET_CREDIT | WALLET_DEBIT */
                        kind: { type: String, default: "PAYMENT" },
                        /** parcel | order */
                        source: { type: String, default: "" },
                        /** Waybill / order id the customer would recognise. */
                        reference: { type: String, default: "" },
                        /** Rupees, signed: positive is money out of the customer. */
                        amount: { type: Number, default: 0 },
                        currency: { type: String, default: "INR" },
                        status: { type: String, default: "" },
                        method: { type: String, default: "" },
                        gatewayPaymentId: { type: String, default: "" },
                        /** GST charged on this line, for the customer's own records. */
                        gstAmount: { type: Number, default: 0 },
                        note: { type: String, default: "" },
                        at: { type: Date, default: Date.now },
                    },
                    { _id: false },
                ),
            ],
            default: [],
            select: false,
        },

        /**
         * @deprecated Phase 4 (P4-7). Use the canonical
         * `Wallet({ownerType:"CUSTOMER", ownerId:<userId>}).availableBalance`
         * via `walletService.getCustomerBalance(userId)` instead.
         *
         * This field remains as a denormalised read-cache for
         * frontend backwards compatibility. Every Wallet credit / debit
         * for a customer now $inc's this field in the same Mongo session
         * (Phase 4 P4-3) so the two stay aligned. Will be removed in
         * Phase 7 after every read site has migrated.
         */
        walletBalance: {
            type: Number,
            default: 0,
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        lastLogin: Date,
    },
    {
        timestamps: true,
    }
);

userSchema.index({ role: 1, isActive: 1 });

userSchema.pre("validate", function(next) {
    if (this.phone) {
        this.phone = normalizePhoneNumber(this.phone);
    }
    next();
});

// Phase 4 P4-8 — reverse virtual to the canonical Wallet document.
//
// Usage:
//   const user = await User.findById(id).populate("wallet");
//   user.wallet.availableBalance  // canonical
//
// This is opt-in via .populate() — existing queries that don't reference
// `wallet` see zero behavioural change.
userSchema.virtual("wallet", {
    ref: "Wallet",
    localField: "_id",
    foreignField: "ownerId",
    justOne: true,
    match: { ownerType: "CUSTOMER" },
});

// Make sure virtuals surface in `.toJSON()` / `.toObject()` so the
// frontend can read them once it migrates.
userSchema.set("toJSON", { virtuals: true });
userSchema.set("toObject", { virtuals: true });

export default mongoose.model("User", userSchema);
