import mongoose from "mongoose";

import Parcel from "../../models/parcel.js";
import ParcelEvent from "../../models/parcelEvent.js";
import Setting from "../../models/setting.js";
import User from "../../models/customer.js";
import { getCapturedPaymentForBooking } from "./porterPaymentService.js";

/**
 * Everything an invoice has to say about a booking, assembled server-side.
 *
 * The invoice is built here rather than in the browser on purpose. A PDF
 * generated from whatever happened to be in a React page's state shows
 * whatever that page had loaded — which is a subset, sometimes stale, and
 * different on the customer screen from the admin screen. The same booking
 * would produce two different invoices depending on who printed it, and
 * neither would be reproducible.
 *
 * This returns one document that both sides render identically: the parties,
 * the route, the package, every fare line, the tax split, how it was paid,
 * and the delivery timeline. The frontend's only job is layout.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Money the invoice prints, never a raw float. */
const line = (label, amount, opts = {}) => ({
  label,
  amount: round2(amount),
  ...opts,
});

/**
 * The seller's own details — who is issuing this invoice.
 *
 * Read from Settings so an operation that rebrands, moves office or gets a
 * new GSTIN does not need a code change to correct its invoices.
 */
async function issuerDetails() {
  const setting = await Setting.findOne({})
    .select("appName companyName address supportEmail supportPhone taxId logoUrl currencySymbol")
    .lean();

  return {
    name: setting?.companyName || setting?.appName || "Delivery Services",
    tradingName: setting?.appName || "",
    address: setting?.address || "",
    email: setting?.supportEmail || "",
    phone: setting?.supportPhone || "",
    /** Falls back to the platform-wide tax id when no per-product GSTIN is set. */
    taxId: setting?.taxId || "",
    logoUrl: setting?.logoUrl || "",
    currencySymbol: setting?.currencySymbol || "₹",
  };
}

/**
 * Turn the stored breakdown into printable lines.
 *
 * Zero-value lines are dropped rather than printed as "₹0.00". An invoice
 * listing five charges the customer did not incur is harder to read and
 * invites the question "why am I being shown this".
 */
function fareLines(breakdown = {}, kind) {
  const lines = [];
  const push = (label, value, note) => {
    if (round2(value) > 0) lines.push(line(label, value, note ? { note } : {}));
  };

  push("Base fare", breakdown.baseFare);
  push(
    "Distance charge",
    breakdown.distanceFare,
    breakdown.perKmCharge ? `at ₹${round2(breakdown.perKmCharge)}/km` : "",
  );
  push("Weight charge", breakdown.weightFare);
  push("Express delivery", breakdown.expressCharge);
  push("Platform fee", breakdown.platformCharge);
  push("Courier handling", breakdown.courierCharge);
  push("Waiting charge", breakdown.waitingCharge);
  push("Return leg", breakdown.returnCharge);

  if (Number(breakdown.billableDays) > 1) {
    lines.push(
      line("Daily rate", breakdown.dailyFare, {
        note: `× ${breakdown.billableDays} days`,
      }),
    );
  }

  if (Number(breakdown.surgeMultiplier) > 1) {
    lines.push(
      line("Surge", 0, { note: `${breakdown.surgeMultiplier}× applied to the subtotal` }),
    );
  }

  return lines;
}

/** The tax block, printed only when tax was actually charged. */
function taxBlock(breakdown = {}) {
  const gstAmount = round2(breakdown.gstAmount);
  if (!(gstAmount > 0)) return null;

  const percent = Number(breakdown.gstPercent) || 0;
  const half = round2(percent / 2);

  return {
    gstin: breakdown.gstin || "",
    percent,
    taxableAmount: round2(breakdown.taxableAmount),
    inclusive: Boolean(breakdown.gstInclusive),
    lines: [
      line(`CGST @ ${half}%`, breakdown.cgst),
      line(`SGST @ ${half}%`, breakdown.sgst),
      ...(round2(breakdown.igst) > 0 ? [line(`IGST @ ${percent}%`, breakdown.igst)] : []),
    ].filter((row) => row.amount > 0),
    total: gstAmount,
  };
}

/**
 * How this was paid, in the terms a customer recognises.
 *
 * Reads the captured PorterPayment when there is one, because that is where
 * the instrument, the gateway reference and the capture time actually live.
 * COD has no such row — the money went hand to hand — so it is described from
 * the booking's own COD state.
 */
async function paymentBlock(kind, booking) {
  const isCod = String(booking.paymentMethod || "").toUpperCase() === "COD";

  if (isCod) {
    const cod = booking.codSettlement;
    const collectedAt = cod?.collectedAt || cod?.riderCollectedAt || null;

    return {
      method: "Cash on pickup",
      instrument: "cash",
      status: booking.paymentStatus,
      paid: booking.paymentStatus === "PAID" || Boolean(collectedAt),
      paidAt: collectedAt,
      reference: "",
      // Meaningful to an admin chasing cash, meaningless to a customer, so
      // the frontend shows it on one screen and not the other.
      settlementStatus: cod?.status || "",
    };
  }

  const payment = await getCapturedPaymentForBooking(kind, booking._id);

  if (!payment) {
    return {
      method: booking.paymentMethod || "Online",
      instrument: "",
      status: booking.paymentStatus,
      paid: booking.paymentStatus === "PAID",
      paidAt: null,
      reference: booking.razorpayPaymentId || "",
      settlementStatus: "",
    };
  }

  const instrument = payment.instrument || {};
  const detail =
    instrument.vpa ||
    (instrument.cardLast4 ? `•••• ${instrument.cardLast4}` : "") ||
    instrument.bank ||
    instrument.wallet ||
    "";

  return {
    method: instrument.method ? instrument.method.toUpperCase() : "Online",
    instrument: detail,
    status: payment.status,
    paid: true,
    paidAt: payment.capturedAt,
    reference: payment.gatewayPaymentId || payment.gatewayOrderId || "",
    gatewayOrderId: payment.gatewayOrderId || "",
    refundedAmount: round2((payment.refundedAmount || 0) / 100),
    settlementStatus: "",
  };
}

/** The delivery timeline, so the invoice doubles as proof of service. */
async function timelineFor(kind, bookingId) {
  const events = await ParcelEvent.find({ parcelId: bookingId })
    .sort({ at: 1 })
    .select("status at note actor")
    .lean();
  return events.map((e) => ({ status: e.status, at: e.at, note: e.note || "" }));
}

/* ==========================================================================
   The two shapes
   ========================================================================== */

function parcelInvoiceBody(booking) {
  return {
    invoiceNo: `PCL-${String(booking._id).slice(-6).toUpperCase()}`,
    serviceName: "Outstation parcel",
    parties: {
      billedTo: {
        name: booking.customerId?.name || booking.pickupAddress?.name || "Customer",
        phone: booking.customerId?.phone || booking.pickupAddress?.phone || "",
        email: booking.customerId?.email || "",
      },
      sender: {
        name: booking.pickupAddress?.name || "",
        phone: booking.pickupAddress?.phone || "",
      },
      receiver: {
        name: booking.dropAddress?.name || "",
        phone: booking.dropAddress?.phone || "",
      },
      rider: booking.deliveryPartnerId
        ? {
            name: booking.deliveryPartnerId.name || "",
            phone: booking.deliveryPartnerId.phone || "",
            vehicle: booking.deliveryPartnerId.vehicleNumber || "",
          }
        : null,
    },
    route: {
      pickup: booking.pickupAddress?.fullAddress || "",
      drop: booking.dropAddress?.fullAddress || "",
      destinationCity: booking.destinationCity || "",
      courier: booking.courierCompany || "",
      courierCompany: booking.courierCompanyId?.name || "",
      distanceKm: booking.distance,
      speed: booking.deliverySpeed,
    },
    shipment: {
      type: booking.packageDetails?.packageType || "",
      segment: booking.packageDetails?.packageSegment || "",
      category: booking.packageDetails?.packageCategory || "",
      weightKg: booking.packageDetails?.weight ?? booking.weight,
      description: booking.packageDetails?.description || "",
    },
    dates: {
      bookedAt: booking.createdAt,
      pickupWindow: booking.pickupWindow,
      preferredPickupDate: booking.preferredPickupDate,
      acceptedAt: booking.acceptedAt,
    },
    status: booking.status,
  };
}

/* ==========================================================================
   Entry point
   ========================================================================== */

/**
 * Build the invoice for one booking.
 *
 * `requesterId` scopes the read for a customer; admins pass `isAdmin` and see
 * any booking. Both get the SAME document — an invoice a customer can be
 * shown and an invoice an admin can be shown differ only in the couple of
 * operational fields the frontend chooses to render, never in the money.
 */
export async function buildPorterInvoice({ kind, bookingId, requesterId, isAdmin = false }) {
  if (!mongoose.Types.ObjectId.isValid(String(bookingId))) {
    const err = new Error("Invalid booking id");
    err.statusCode = 400;
    throw err;
  }

  const scope = isAdmin ? {} : { customerId: requesterId };

  const booking = await Parcel.findOne({ _id: bookingId, ...scope })
    .populate("customerId", "name phone email")
    .populate("deliveryPartnerId", "name phone vehicleNumber")
    .populate("courierCompanyId", "name phone")
    .lean();

  if (!booking) {
    const err = new Error("Booking not found");
    err.statusCode = 404;
    throw err;
  }

  const breakdown = booking.fareBreakdown || {};
  const [issuer, payment, timeline] = await Promise.all([
    issuerDetails(),
    paymentBlock(kind, booking),
    timelineFor(kind, booking._id),
  ]);

  const body = parcelInvoiceBody(booking);

  const charges = fareLines(breakdown, kind);
  /** What the customer saved in total — the headline figure, tax included. */
  const discountAmount = round2(booking.discountAmount || 0);

  /**
   * The discount as it applies to the TAXABLE value.
   *
   * The coupon comes off the tax-inclusive fare, so part of what the customer
   * saved is tax they no longer pay. An invoice line of the full saving
   * printed above a tax line computed after the discount does not add up:
   * the charges, the discount and the tax have to reconcile to the total on
   * the face of the document.
   *
   * Both halves are recorded, so this is a subtraction rather than a
   * re-derivation. Falls back to the full amount for bookings written before
   * the pre-discount value was kept, and for untaxed bookings the two are the
   * same number anyway.
   */
  const preDiscountTaxable = round2(breakdown.preDiscountTaxableAmount || 0);
  const taxableDiscount =
    preDiscountTaxable > 0 && Number(breakdown.taxableAmount) > 0
      ? round2(preDiscountTaxable - Number(breakdown.taxableAmount))
      : discountAmount;

  if (discountAmount > 0) {
    // Bypasses `fareLines`'s zero-value filter on purpose — a negative
    // amount would otherwise be silently dropped by its `> 0` guard.
    charges.push(
      line(
        `Coupon discount${booking.couponSnapshot?.code ? ` (${booking.couponSnapshot.code})` : ""}`,
        -taxableDiscount,
      ),
    );
  }
  const tax = taxBlock(breakdown);
  const payableTotal = round2(
    Number.isFinite(Number(booking.payableFare)) && booking.payableFare > 0
      ? booking.payableFare
      : booking.fare,
  );

  /**
   * The subtotal is the taxable value, not the sum of the printed lines.
   *
   * They can differ legitimately — a minimum fare replaces the line items, a
   * surge multiplies them — and printing a subtotal that does not equal
   * total-minus-tax is the single fastest way to make an invoice look wrong.
   * `taxableAmount` is what the tax was actually computed on, so it is the
   * only number that reconciles.
   *
   * `??` is not enough here: outstation bookings written before the tax split
   * was persisted carry a schema-default `taxableAmount` of 0, which is a real
   * number and so survives `??` — printing a ₹0 subtotal under a full total.
   * A zero taxable value on a booking that charged something is missing data,
   * not a free delivery, so it falls back to the same derivation.
   */
  const storedTaxable = Number(breakdown.taxableAmount) || 0;
  const subtotal = round2(
    storedTaxable > 0
      ? storedTaxable
      : round2(payableTotal - (Number(breakdown.gstAmount) || 0)),
  );

  return {
    ...body,
    kind,
    bookingId: String(booking._id),
    issuedAt: new Date(),
    issuer: {
      ...issuer,
      // A product-specific GSTIN wins over the platform-wide tax id, because
      // that is the number the tax was actually charged under.
      taxId: breakdown.gstin || issuer.taxId,
    },
    charges,
    subtotal,
    tax,
    discount:
      discountAmount > 0
        ? {
            code: booking.couponSnapshot?.code || "",
            /** Off the taxable value — the figure the charge lines use. */
            amount: taxableDiscount,
            /** Total saving including the tax not charged. For "you saved". */
            totalSaving: discountAmount,
          }
        : null,
    total: payableTotal,
    amountInWords: rupeesInWords(payableTotal),
    payment,
    timeline,
    // A cancelled or refunded booking must say so on its face, or an invoice
    // becomes a receipt for something that did not happen.
    notice:
      booking.status === "CANCELLED"
        ? "This booking was cancelled."
        : payment.refundedAmount > 0
          ? `₹${payment.refundedAmount} was refunded against this booking.`
          : "",
  };
}

/* ==========================================================================
   Amount in words
   ========================================================================== */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return TENS[tens] + (ones ? ` ${ONES[ones]}` : "");
}

/**
 * Indian numbering: thousand, lakh, crore — not the Western thousand/million.
 *
 * An invoice denominated in rupees that spells the amount in millions reads
 * as foreign, and on a tax document that matters.
 */
function integerInWords(value) {
  if (value === 0) return "Zero";

  const crore = Math.floor(value / 10000000);
  const lakh = Math.floor((value % 10000000) / 100000);
  const thousand = Math.floor((value % 100000) / 1000);
  const hundred = Math.floor((value % 1000) / 100);
  const rest = value % 100;

  const parts = [];
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigits(rest));

  return parts.join(" ");
}

export function rupeesInWords(amount) {
  const value = round2(amount);
  const rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);

  const words = `${integerInWords(rupees)} Rupees`;
  return paise ? `${words} and ${twoDigits(paise)} Paise Only` : `${words} Only`;
}

/**
 * A customer's own recent transactions, for the wallet / payments screen.
 *
 * Reads the capped strip on the user document — one document, already
 * ordered — rather than paginating a collection, because this is the "recent
 * activity" answer and says so by never claiming a total.
 */
export async function getCustomerPorterTransactions(customerId, limit = 25) {
  const user = await User.findById(customerId).select("+transactions").lean();
  return (user?.transactions || []).slice(0, Math.max(1, Number(limit) || 25));
}
