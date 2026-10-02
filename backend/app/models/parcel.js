import mongoose from "mongoose";
import { gstBreakdownFields } from "./shared/gstSchemas.js";

const addressDetailsSchema = new mongoose.Schema({
  fullAddress: {
    type: String,
    required: true,
  },
  lat: {
    type: Number,
    required: true,
  },
  lng: {
    type: Number,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  pincode: {
    type: String,
    trim: true,
    default: "",
  },
  /** Only meaningful on pickupAddress — matched against ParcelCityRate for the courier's city-to-city charge. */
  city: {
    type: String,
    trim: true,
    default: "",
  },
}, { _id: false });

/**
 * Who the parcel is actually for, once it leaves the courier company's counter.
 *
 * Deliberately separate from `addressDetailsSchema`: `dropAddress` on this
 * model is always the customer-selected courier company the rider physically
 * drives the parcel to and drops with a photo proof (see createParcel) — never
 * the end customer. This is the address the courier company hands the parcel
 * on to from there; no lat/lng, since nobody in this flow dispatches or
 * navigates against it — it exists to be printed on a shipping label.
 */
const receiverAddressSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  fullAddress: {
    type: String,
    required: true,
  },
  city: {
    type: String,
    trim: true,
    default: "",
  },
  state: {
    type: String,
    trim: true,
    default: "",
  },
  pincode: {
    type: String,
    trim: true,
    default: "",
  },
}, { _id: false });

const packageDetailsSchema = new mongoose.Schema({
  packageType: {
    type: String,
    required: true,
    trim: true,
  },
  /** Customer segment: 'personal' or 'business' (optional). */
  packageSegment: {
    type: String,
    trim: true,
    default: "",
  },
  /** Category chosen within the selected segment (optional). */
  packageCategory: {
    type: String,
    trim: true,
    default: "",
  },
  weight: {
    type: Number,
    required: true,
    max: 50,
  },
  description: {
    type: String,
    trim: true,
  },
}, { _id: false });

const parcelSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    pickupAddress: {
      type: addressDetailsSchema,
      required: true,
    },
    dropAddress: {
      type: addressDetailsSchema,
      required: true,
    },
    /**
     * The end customer this outstation parcel is actually going to — who the
     * courier company hands it to after the warehouse. Optional at the
     * schema level so a local parcel (which delivers straight to
     * `dropAddress`, no warehouse in between) and any parcel booked before
     * this field existed are unaffected.
     */
    receiverAddress: {
      type: receiverAddressSchema,
      default: undefined,
    },
    packageDetails: {
      type: packageDetailsSchema,
      required: true,
    },
    /** Preferred courier company for drop-off (e.g. Blue Dart, DTDC). */
    courierCompany: {
      type: String,
      trim: true,
      default: "",
    },
    /** Delivery speed chosen by customer: normal | express */
    deliverySpeed: {
      type: String,
      enum: ["normal", "express"],
      default: "normal",
      index: true,
    },
    /** Destination city where the parcel should go. */
    destinationCity: {
      type: String,
      trim: true,
      default: "",
    },
    /** Preferred date / window end for parcel pickup. */
    preferredPickupDate: {
      type: Date,
      default: null,
    },
    /** When delivery boy can come: today | 7_days | 15_days | 30_days | custom_days | specific */
    pickupWindow: {
      type: String,
      enum: ["today", "7_days", "15_days", "30_days", "custom_days", "specific"],
      default: "today",
    },
    /** Number of days in window (0 for today, null for specific date). */
    pickupWindowDays: {
      type: Number,
      default: 0,
    },
    weight: {
      type: Number,
      required: true,
      max: 50,
    },
    distance: {
      type: Number,
      required: true,
    },
    /**
     * The GRAND TOTAL the customer pays, tax included.
     *
     * Everything downstream that quotes money to a human — the Razorpay
     * order, the COD amount the rider collects, the invoice total — reads
     * this one field, so keeping the tax inside it is what stops the three
     * from ever disagreeing. The pre-tax value is
     * `fareBreakdown.taxableAmount`; rider payout is computed from the
     * pre-tax line items, so no rider is paid a share of somebody's GST.
     */
    fare: {
      type: Number,
      required: true,
    },
    /** Snapshot used for rider payout (base + distance only; weight/courier excluded). */
    fareBreakdown: {
      baseFare: { type: Number, default: 0 },
      distanceFare: { type: Number, default: 0 },
      weightFare: { type: Number, default: 0 },
      courierCharge: { type: Number, default: 0 },
      platformCharge: { type: Number, default: 0 },
      companyCharge: { type: Number, default: 0 },
      expressCharge: { type: Number, default: 0 },
      /** Per-day fare before multi-day multiplier. */
      dailyFare: { type: Number, default: 0 },
      /** Number of days charged (today=1, 7/15/30, or till-date span). */
      billableDays: { type: Number, default: 1 },
      ...gstBreakdownFields,
    },
    courierCompanyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CourierCompany",
      default: null,
    },
    /** Coupon applied at booking time, if any. Discount comes out of admin
     *  margin only — `fare` (and everything derived from it, like rider
     *  earning) is untouched; `payableFare` is what the customer is actually
     *  charged and what payment/COD collection must read. */
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
      index: true,
    },
    couponSnapshot: { type: Object, default: null },
    discountAmount: { type: Number, default: 0 },
    payableFare: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      // REFUNDED joined the set when porter payments gained a real gateway
      // lifecycle: a refund webhook has to land somewhere, and without this
      // value it would either be dropped or written as FAILED, which reads
      // to a customer as "your payment did not go through" when in fact it
      // went through and came back.
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
      default: "PENDING",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["UPI", "CARD", "WALLET", "COD"],
      required: true,
    },
    /**
     * COD cash chain: Customer -> Rider (collect at pickup) -> Admin.
     *
     * The rider deposits what they collected and an admin approves it; see
     * services/riderCashService.js. WITH_SELLER survives only for the legacy
     * seller-hub route (parcels that actually carry a sellerId). Outstation
     * parcels drop at a courier company counter, which nobody logs in as, so
     * they go from RIDER_HOLDING straight to REMITTED_TO_ADMIN when a deposit
     * is approved.
     */
    codSettlement: {
      collectAmount: { type: Number, default: 0 },
      status: {
        type: String,
        enum: [
          "NOT_APPLICABLE",
          "COLLECT_PENDING",
          "RIDER_HOLDING",
          "WITH_SELLER",
          "REMITTED_TO_ADMIN",
        ],
        default: "NOT_APPLICABLE",
        index: true,
      },
      riderCollectedAt: { type: Date, default: null },
      handedToSellerAt: { type: Date, default: null },
      sellerConfirmedAt: { type: Date, default: null },
      remittedAt: { type: Date, default: null },
      sellerRazorpayOrderId: { type: String, default: null },
      sellerRazorpayPaymentId: { type: String, default: null },
    },
    /**
     * A COD customer choosing to pay digitally at the door instead.
     *
     * When this is paid the booking stops being COD — `paymentMethod` becomes
     * UPI and `codSettlement` goes back to NOT_APPLICABLE — so the money
     * lands with admin directly and never enters the rider deposit pipeline.
     */
    codOnlineQr: {
      /**
       * A Razorpay Payment Link, switching this COD booking to pay online.
       * `imageUrl` is a QR we render ourselves of the link's own URL (so any
       * camera/scanner reads it as a tappable https:// link, not a raw UPI
       * deep-link string) — scanning it and tapping `paymentLinkUrl` land on
       * the exact same Razorpay checkout page.
       */
      paymentLinkId: { type: String, default: null },
      paymentLinkUrl: { type: String, default: null },
      imageUrl: { type: String, default: null },
      /** Paise, matching what Razorpay was asked to collect. */
      amount: { type: Number, default: 0 },
      createdAt: { type: Date, default: null },
      paidAt: { type: Date, default: null },
      paymentId: { type: String, default: null },
    },
    /** Razorpay order id for UPI/online parcel payments. */
    razorpayOrderId: {
      type: String,
      default: null,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: null,
    },
    deliveryPartnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      default: null,
      index: true,
    },
    /**
     * The zone the pickup point resolved into at creation, for outstation
     * bookings only (see resolveFirstMile/createParcel). Null for a local
     * parcel, or an outstation one booked before any zone existed. This is
     * the hard boundary outstation dispatch matches candidate riders and
     * candidate warehouses against — see deliveryNearbyService.js and
     * tryAutoAssignParcelToWarehouse in parcelWorkflowService.js.
     */
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryZone",
      default: null,
      index: true,
    },
    /** 'outstation' (delivers to warehouse) or 'local' (delivers to seller/receiver) */
    parcelType: {
      type: String,
      enum: ["outstation", "local"],
      default: "outstation",
      index: true,
    },
    /** Parcel hub seller who auto-accepts within their service radius (local parcels only). */
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
      index: true,
    },
    searchExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    searchMeta: {
      radiusKm: { type: Number, default: 5 },
      attempt: { type: Number, default: 1 },
      lastBroadcastAt: { type: Date, default: null },
    },
    skippedBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
    }],
    acceptedAt: {
      type: Date,
      default: null,
    },
    /**
     * Snapshot of the rider's own GPS fix the moment they accepted the job.
     *
     * Used only to compute payout distance — how far the rider actually has
     * to travel from wherever they were standing to the pickup point (see
     * computeRiderParcelEarnings in services/parcelWorkflowService.js). Never
     * backfilled for older parcels, which is why every reader of this field
     * has to tolerate it being null.
     */
    riderAcceptLocation: {
      type: new mongoose.Schema(
        {
          lat: { type: Number },
          lng: { type: Number },
        },
        { _id: false },
      ),
      default: null,
    },
    /**
     * Customer late-pickup refund request (Normal 30-min SLA).
     * COD still collects full cash; admin may credit wallet as compensation.
     */
    lateRefundRequest: {
      status: {
        type: String,
        enum: ["none", "requested", "approved", "rejected"],
        default: "none",
        index: true,
      },
      reason: { type: String, default: "", trim: true },
      requestedAt: { type: Date, default: null },
      requestedAmount: { type: Number, default: 0 },
      /** Snapshot: how late captain was when customer requested. */
      measuredAt: { type: Date, default: null },
      deadlineAt: { type: Date, default: null },
      lateByMinutes: { type: Number, default: 0 },
      lateByLabel: { type: String, default: "" },
      approvedAmount: { type: Number, default: 0 },
      approvedAt: { type: Date, default: null },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
      rejectedAt: { type: Date, default: null },
      rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
      adminNote: { type: String, default: "", trim: true },
    },
    otp: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "REQUESTED",
        "SEARCHING",
        "ACCEPTED",
        "RIDER_ASSIGNED",
        "PICKUP_REACHED",
        "PICKED_UP",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED"
      ],
      default: "REQUESTED",
      index: true,
    },
    pickupProofImage: {
      type: String,
      default: "",
    },
    deliveryProofImage: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Keeps `payableFare` (what payment/COD collection reads) correct even for
 * code paths that set `fare`/`discountAmount` without also setting
 * `payableFare` explicitly — it always equals `fare - discountAmount`.
 */
parcelSchema.pre("validate", function syncPayableFare(next) {
  if (this.isModified("fare") || this.isModified("discountAmount") || this.payableFare == null) {
    this.payableFare = Math.max(0, Number(this.fare || 0) - Number(this.discountAmount || 0));
  }
  next();
});

/**
 * `warehouseId`/`deliveryInstruction` were retired when the warehouse hop was
 * removed (rider now drives straight to the customer-picked courier
 * company). Mongo keeps whatever was last written on old bookings until
 * explicitly unset, so a parcel saved before this migration otherwise
 * carries the dead fields in every API response forever. Runs once per
 * process — this touches every parcel ever booked, not a singleton doc.
 */
let legacyFieldsCleaned = false;
parcelSchema.statics.cleanupLegacyFields = async function () {
  if (legacyFieldsCleaned) return;
  legacyFieldsCleaned = true;
  await this.collection.updateMany(
    { $or: [{ warehouseId: { $exists: true } }, { deliveryInstruction: { $exists: true } }] },
    { $unset: { warehouseId: "", deliveryInstruction: "" } },
  );
};

export default mongoose.model("Parcel", parcelSchema);
