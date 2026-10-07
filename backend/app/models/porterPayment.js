import mongoose from "mongoose";
import {
  ALL_PORTER_BOOKING_KINDS,
  ALL_PORTER_PAYER_TYPES,
  ALL_PORTER_PAYMENT_PURPOSES,
  ALL_PORTER_PAYMENT_SOURCES,
  ALL_PORTER_PAYMENT_STATUSES,
  PORTER_PAYMENT_STATUS,
} from "../constants/porterPayment.js";

/**
 * Every rupee that moves through a payment gateway on the porter desk.
 *
 * Before this collection existed, a porter booking recorded a payment by
 * writing two loose strings onto itself — `razorpayOrderId` and
 * `razorpayPaymentId` — and flipping a four-value `paymentStatus`. That is
 * not a payment record. It cannot answer what the customer actually paid
 * with, whether the money was authorised or captured, what the gateway
 * charged in fees, when each state change happened or what told us about it,
 * whether a refund went out, or what the fare looked like at the moment of
 * sale. It also had no webhook: a customer whose browser died between paying
 * and returning had simply not paid, as far as the database was concerned.
 *
 * One row per ATTEMPT, not per booking. A customer who dismisses the checkout
 * sheet and pays on the second try leaves two rows, and both are true — the
 * first genuinely was abandoned. `attemptCount` orders them.
 *
 * The snapshot fields (`fareSnapshot`, `taxSnapshot`, `bookingSnapshot`) are
 * copies, not references, and that is the point: an invoice printed a year
 * from now has to show the rate card that was actually charged, not whatever
 * the admin has since edited it to.
 */

const statusChangeSchema = new mongoose.Schema(
  {
    fromStatus: { type: String, enum: ALL_PORTER_PAYMENT_STATUSES, required: true },
    toStatus: { type: String, enum: ALL_PORTER_PAYMENT_STATUSES, required: true },
    source: { type: String, enum: ALL_PORTER_PAYMENT_SOURCES, required: true },
    reason: { type: String, default: "" },
    /** The gateway's own event id, when a webhook caused this. */
    gatewayEventId: { type: String, default: null },
    /** Gateway state string exactly as received, before mapping. */
    gatewayState: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const refundSchema = new mongoose.Schema(
  {
    gatewayRefundId: { type: String, default: null },
    /** Paise, like every other amount on this document. */
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, default: "" },
    reason: { type: String, default: "" },
    speed: { type: String, default: "" },
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * How the customer actually paid, read off the gateway's payment entity.
 *
 * Support cannot resolve a "charged twice" claim without knowing whether it
 * was the same VPA, and finance cannot reconcile a bank statement without the
 * instrument. None of this was ever captured.
 */
const instrumentSchema = new mongoose.Schema(
  {
    /** upi | card | netbanking | wallet | emi | paylater */
    method: { type: String, default: "" },
    vpa: { type: String, default: "" },
    bank: { type: String, default: "" },
    wallet: { type: String, default: "" },
    cardLast4: { type: String, default: "" },
    cardNetwork: { type: String, default: "" },
    cardType: { type: String, default: "" },
    /** The gateway's own contact/email echo, for dispute lookups. */
    contact: { type: String, default: "" },
    email: { type: String, default: "" },
  },
  { _id: false },
);

const porterPaymentSchema = new mongoose.Schema(
  {
    /* ================= What this is for ================= */

    purpose: {
      type: String,
      enum: ALL_PORTER_PAYMENT_PURPOSES,
      required: true,
      index: true,
    },

    /**
     * Which booking collection `bookingId` points into. Null on a rider cash
     * deposit, which covers many bookings rather than one.
     */
    bookingKind: {
      type: String,
      enum: [...ALL_PORTER_BOOKING_KINDS, null],
      default: null,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    /** Human waybill (CP-XXXX / short parcel id), quoted in support chats. */
    referenceId: { type: String, default: "", index: true },

    /* ================= Who paid ================= */

    payerType: {
      type: String,
      enum: ALL_PORTER_PAYER_TYPES,
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Delivery",
      default: null,
      index: true,
    },
    /**
     * Set the moment a WALLET_TOPUP payment has been credited to the
     * customer's wallet. Claimed atomically before the credit so a verify and
     * a webhook landing together can never credit the same payment twice.
     */
    walletCreditedAt: { type: Date, default: null },
    /** Set once a rider deposit has been turned into a CashDeposit row. */
    cashDepositId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CashDeposit",
      default: null,
      index: true,
    },

    /* ================= The gateway ================= */

    gatewayName: { type: String, default: "RAZORPAY", index: true },
    /**
     * The gateway's order id. Unique and sparse — sparse because the row is
     * written the instant we decide to charge, a hair before the gateway
     * answers, so a failure to open the order leaves a truthful row with no
     * id rather than no row at all.
     *
     * No `default: null` on purpose: a sparse index only skips a document
     * where the field is genuinely ABSENT, not one that explicitly stores
     * `null` — `default: null` made Mongoose write that literal null into
     * every row created before the gateway answers, so a second attempt in
     * that same window collided on the unique index
     * ("dup key: { gatewayOrderId: null }"). Leaving the field unset until
     * it is actually assigned keeps it genuinely absent, which is what the
     * sparse index needs to allow any number of in-flight rows.
     */
    gatewayOrderId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    gatewayPaymentId: { type: String, default: null, index: true },
    /**
     * The checkout receipt HMAC. Never returned to a client: it is proof
     * material for a dispute, and echoing it back weakens that.
     */
    gatewaySignature: { type: String, default: null, select: false },
    /** Our own receipt string, echoed in notes so webhooks can find this row. */
    merchantReference: { type: String, default: null, index: true, sparse: true },
    notes: { type: mongoose.Schema.Types.Mixed, default: {} },

    /* ================= Money (paise, always) ================= */

    /**
     * Paise, matching what the gateway was asked to collect. Rupees are a
     * display concern; storing them invites the float drift that makes a
     * ledger disagree with a bank statement by a paisa a thousand times over.
     */
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    refundedAmount: { type: Number, default: 0, min: 0 },
    /** What the gateway kept. Only known once the payment entity arrives. */
    gatewayFee: { type: Number, default: 0, min: 0 },
    gatewayTax: { type: Number, default: 0, min: 0 },

    /* ================= State ================= */

    status: {
      type: String,
      enum: ALL_PORTER_PAYMENT_STATUSES,
      default: PORTER_PAYMENT_STATUS.CREATED,
      index: true,
    },
    statusHistory: { type: [statusChangeSchema], default: [] },
    refunds: { type: [refundSchema], default: [] },
    instrument: { type: instrumentSchema, default: () => ({}) },

    attemptCount: { type: Number, default: 1, min: 1 },
    idempotencyKey: { type: String, default: null },
    correlationId: { type: String, default: null },

    failureReason: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    errorDescription: { type: String, default: "" },
    errorStep: { type: String, default: "" },

    authorizedAt: { type: Date, default: null },
    capturedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    /**
     * Set when the most recent refund ATTEMPT (not the original payment)
     * could not be initiated at the gateway — a network failure, a gateway
     * outage, or a refund the gateway itself rejected. Cleared the next time
     * a refund attempt succeeds. This is what an admin screen checks to know
     * a cancelled, paid booking still needs its money sent back by hand.
     */
    refundFailureReason: { type: String, default: "" },
    refundFailedAt: { type: Date, default: null },

    /* ================= Snapshots ================= */

    /**
     * The fare exactly as charged. An admin editing the rate card must never
     * change what an old invoice says was paid.
     */
    fareSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    /**
     * GST as applied at the moment of sale — rate, taxable value, and the
     * CGST/SGST split. Independent of the live config for the same reason.
     */
    taxSnapshot: {
      gstEnabled: { type: Boolean, default: false },
      gstPercent: { type: Number, default: 0 },
      gstin: { type: String, default: "" },
      /** Rupees. Invoice-facing values, kept readable for the PDF. */
      taxableAmount: { type: Number, default: 0 },
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      gstAmount: { type: Number, default: 0 },
      placeOfSupply: { type: String, default: "" },
    },
    /** Route, package and parties, frozen for the invoice. */
    bookingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

    /**
     * The last raw gateway payload seen, and every webhook event id applied.
     * The id list is what makes a redelivery provably a no-op rather than
     * probably one.
     */
    rawGatewayResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    appliedEventIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

/* ================= Indexes ================= */

/** A booking's own attempts, newest first — what the detail screen reads. */
porterPaymentSchema.index({ bookingKind: 1, bookingId: 1, createdAt: -1 });
/** The customer's payment history. */
porterPaymentSchema.index({ customerId: 1, createdAt: -1 });
/** A rider's deposit attempts. */
porterPaymentSchema.index({ riderId: 1, purpose: 1, createdAt: -1 });
/** Reconciliation sweeps: everything still in flight, oldest first. */
porterPaymentSchema.index({ status: 1, createdAt: 1 });
/** GST and revenue reporting windows. */
porterPaymentSchema.index({ purpose: 1, status: 1, capturedAt: -1 });
/**
 * One live attempt per booking. Two open gateway orders against the same
 * booking is how a customer ends up paying twice, so the database refuses it
 * rather than relying on every caller to check first.
 */
porterPaymentSchema.index(
  { bookingKind: 1, bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [PORTER_PAYMENT_STATUS.CREATED, PORTER_PAYMENT_STATUS.PENDING] },
      bookingId: { $type: "objectId" },
    },
  },
);

/* ================= Helpers ================= */

porterPaymentSchema.methods.amountRupees = function amountRupees() {
  return Number((this.amount / 100).toFixed(2));
};

/** True once the money is genuinely with the platform. */
porterPaymentSchema.methods.isPaid = function isPaid() {
  return (
    this.status === PORTER_PAYMENT_STATUS.CAPTURED ||
    this.status === PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED
  );
};

/**
 * What a customer or rider app may see. Excludes the signature, the raw
 * gateway payloads, and the applied-event bookkeeping — none of which mean
 * anything outside the server, and the first of which is proof material.
 */
export const PORTER_PAYMENT_CLIENT_FIELDS = [
  "purpose",
  "bookingKind",
  "bookingId",
  "referenceId",
  "gatewayName",
  "gatewayOrderId",
  "gatewayPaymentId",
  "amount",
  "currency",
  "refundedAmount",
  "status",
  "statusHistory",
  "refunds",
  "instrument",
  "attemptCount",
  "failureReason",
  "errorDescription",
  "authorizedAt",
  "capturedAt",
  "failedAt",
  "refundedAt",
  "refundFailureReason",
  "refundFailedAt",
  "taxSnapshot",
  "createdAt",
  "updatedAt",
].join(" ");

export default mongoose.model("PorterPayment", porterPaymentSchema);
