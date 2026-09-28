import mongoose from "mongoose";

/**
 * A rider handing collected COD cash back to the platform.
 *
 * Before this existed, COD cash had nowhere to go. A porter rider collected
 * cash at pickup, the booking moved to RIDER_HOLDING, and then nothing —
 * `REMITTED_TO_ADMIN` was only ever written by a seller-side Razorpay flow
 * that outstation parcels (which carry no seller) could never reach. The cash
 * sat on the rider's ledger permanently.
 *
 * This is the missing half: the rider declares what they paid back, how, and
 * attaches proof. An ONLINE deposit settles itself the moment its Razorpay
 * payment is verified — the captured payment is proof enough. A legacy
 * CASH/UPI/BANK_TRANSFER/OTHER deposit still needs an admin to check the
 * screenshot and approve, since nothing there proves a real handover on its
 * own. Only on settlement (auto or admin-approved) do the covered bookings
 * move to REMITTED_TO_ADMIN.
 *
 * `items` is resolved when the request is raised, oldest booking first, so an
 * approval maps to specific bookings rather than a floating balance — the
 * admin can always answer "which jobs did this ₹X cover".
 */

const depositItemSchema = new mongoose.Schema(
  {
    /** Which collection the booking lives in. */
    kind: {
      type: String,
      enum: ["parcel", "city_parcel"],
      required: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    /** COD amount held for this booking, snapshotted at request time. */
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Human reference shown to the admin (waybill / short id). */
    label: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

const cashDepositSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    /**
     * How the money came back.
     *
     * ONLINE is the current flow: the rider pays through the gateway into the
     * platform's own account, and `porterPaymentId` points at the captured
     * PorterPayment that proves it. No admin step — the payment being
     * captured IS what moves the covered bookings to REMITTED_TO_ADMIN.
     *
     * UPI / BANK_TRANSFER / CASH / OTHER are the legacy out-of-band methods,
     * kept so historical deposits still load and so an operation can fall
     * back if the gateway is down.
     */
    method: {
      type: String,
      enum: ["ONLINE", "UPI", "BANK_TRANSFER", "CASH", "OTHER"],
      required: true,
    },

    /** Gateway payment id on an ONLINE deposit; the UTR a rider typed on a legacy one. */
    reference: {
      type: String,
      trim: true,
      default: "",
    },

    /**
     * The captured gateway payment behind an ONLINE deposit.
     *
     * This is what makes the admin's approval a check rather than a guess:
     * the money is provably in the platform's account before anyone clicks.
     */
    porterPaymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PorterPayment",
      default: null,
      index: true,
    },

    /** Screenshot or receipt photo. Only ever set on a legacy out-of-band deposit. */
    proofImageUrl: {
      type: String,
      trim: true,
      default: "",
    },

    note: {
      type: String,
      trim: true,
      default: "",
    },

    items: {
      type: [depositItemSchema],
      default: [],
    },

    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    adminNote: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

/** The rider's own history screen, newest first. */
cashDepositSchema.index({ riderId: 1, status: 1, createdAt: -1 });
/** The admin approval queue. */
cashDepositSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("CashDeposit", cashDepositSchema);
