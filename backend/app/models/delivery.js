import mongoose from "mongoose";

const deliverySchema = new mongoose.Schema(
    {
    language: {
        type: String,
        default: "en",
        trim: true,
        lowercase: true,
    },
        name: {
            type: String,
            required: true,
            trim: true,
        },

        phone: {
            type: String,
            required: true,
            unique: true,
        },

        vehicleType: {
            type: String,
            enum: ["bike", "cycle", "scooter"],
            default: "bike",
        },

        email: {
            type: String,
            trim: true,
        },

        address: {
            type: String,
            trim: true,
        },

        accountHolder: {
            type: String,
            trim: true,
        },

        accountNumber: {
            type: String,
            trim: true,
        },

        ifsc: {
            type: String,
            trim: true,
        },

        bankName: {
            type: String,
            trim: true,
            default: "",
        },

        /**
         * Where withdrawals actually get paid out.
         *
         * Bank fields above were captured once at signup and could never be
         * changed, and the admin approving a withdrawal was never shown any of
         * them — they had to approve blind. These are editable by the rider
         * from their own panel, and are sent to the admin with every
         * withdrawal request so there is a real destination on screen.
         */
        upiId: {
            type: String,
            trim: true,
            default: "",
        },

        /** Rider's own collect-money QR, uploaded as an image. */
        qrImageUrl: {
            type: String,
            trim: true,
            default: "",
        },

        documents: {
            // Legacy single-image field, kept so partners who signed up
            // before front/back capture was added still show their file.
            aadhar: { type: String },
            aadharFront: { type: String },
            aadharBack: { type: String },
            pan: { type: String },
            drivingLicense: { type: String },
        },

        vehicleNumber: {
            type: String,
            trim: true,
        },

        drivingLicenseNumber: {
            type: String,
            trim: true,
        },

        aadharNumber: {
            type: String,
            trim: true,
        },

        panNumber: {
            type: String,
            trim: true,
        },

        currentArea: {
            type: String,
            trim: true,
        },
        profileImage: {
            type: String,
            trim: true,
        },

        experience: {
            type: String,
            trim: true,
        },

        experienceDetails: {
            type: String,
            trim: true,
        },

        isVerified: {
            type: Boolean,
            default: false,
        },

        /**
         * The onboarding application's own lifecycle, kept alongside
         * `isVerified` (which many other queries already gate on) rather than
         * replacing it. `isVerified` only ever answers "can this rider work
         * right now" — it has no way to say *why not yet*, so a rejected
         * applicant and a brand-new one both read as identically unverified.
         * This field is what the admin queue actually shows and filters on.
         */
        applicationStatus: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
        },

        /**
         * Why the admin rejected the application. Kept after a resubmission so
         * the review queue can show what the rider was told to fix.
         */
        rejectionReason: {
            type: String,
            trim: true,
            default: "",
        },
        rejectedAt: {
            type: Date,
        },
        /** Set when a rejected rider resubmits; cleared never, so the history stays visible. */
        reappliedAt: {
            type: Date,
        },
        reapplyCount: {
            type: Number,
            default: 0,
        },

        /**
         * Admin on/off switch for an already-approved rider — separate from
         * `applicationStatus`, which is about the onboarding decision, not
         * about suspending someone who already passed it. `requireActiveDelivery`
         * (see middleware/authMiddleware.js) is what actually enforces this on
         * every authenticated request; the JWT itself stays valid until it
         * expires, same as `requireActiveCustomer` does for customers.
         */
        isActive: {
            type: Boolean,
            default: true,
        },

        isOnline: {
            type: Boolean,
            default: false,
        },

        /**
         * How much COD cash this rider may hold before they stop being
         * offered work.
         *
         * Null means "use the fleet-wide limit" (Setting.porterCash.
         * globalCashLimit). That is deliberately distinct from 0, which is a
         * real limit meaning this rider may carry no cash at all — a sensible
         * thing to want for someone on probation. Collapsing the two would
         * make that impossible to express.
         *
         * Enforcement lives in services/porter/riderCashLimitService.js and
         * is read by both job feeds and both accept paths. Nothing reads this
         * field directly: the resolved limit always comes from that service,
         * so the global fallback cannot be forgotten at one call site.
         */
        cashLimit: {
            type: Number,
            default: null,
            min: 0,
        },

        /**
         * Delivery zones this rider is assigned to work.
         *
         * Empty means "wherever they physically are" — the local job feed
         * then falls back to resolving zones from the rider's live GPS fix,
         * which is how zone gating worked before assignment existed and
         * remains the right default for a fleet that roams.
         *
         * A non-empty list is a HARD restriction: the rider sees local jobs
         * only from these zones, even if they are standing inside a different
         * one. That is the point — it is how an operation staffs a specific
         * area rather than letting whoever drifts past pick the work up.
         */
        zoneIds: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "DeliveryZone",
            },
        ],

        /** True while rider has an in-progress delivery / return / parcel job. */
        isBusy: {
            type: Boolean,
            default: false,
        },
        isParcelService: {
            type: Boolean,
            default: true,
        },
        location: {
            type: {
                type: String,
                enum: ["Point"],
                default: "Point",
            },
            coordinates: {
                type: [Number],
                default: [0, 0],
            },
        },
        role: {
            type: String,
            default: "delivery",
        },

        otp: {
            type: String,
            select: false,
        },

        otpExpiry: {
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

        lastLogin: Date,

        /** Last GPS fix from POST /delivery/location (for radius matching). */
        lastLocationAt: {
            type: Date,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

deliverySchema.index({ location: "2dsphere" });
deliverySchema.index({ isOnline: 1, isVerified: 1 });
/** The admin's "which riders cover this area" lookup. */
deliverySchema.index({ zoneIds: 1 });

deliverySchema.virtual('id').get(function () {
    return this._id.toHexString();
});

export default mongoose.model("Delivery", deliverySchema);
