import { applyGst, gstFromBreakdown, normalizeGstConfig } from "../app/utils/gst.js";
import {
  PORTER_PAYMENT_STATUS as P,
  canTransitionPorterPayment,
  bookingPaymentStatusFor,
} from "../app/constants/porterPayment.js";
import { applyBillableDaysToFare } from "../app/utils/parcelFare.js";

/**
 * The two pieces of porter money logic that are pure, and therefore the two
 * where a silent error would be invisible until an accountant found it.
 *
 * GST that does not reconcile with its own halves, or a payment that can be
 * dragged backwards out of CAPTURED by a late webhook, both cost real money
 * and neither produces an error at the time.
 */

describe("GST calculation", () => {
  it("adds tax on top when the rate card is exclusive", () => {
    const gst = applyGst(100, { enabled: true, percent: 18 });

    expect(gst.taxableAmount).toBe(100);
    expect(gst.gstAmount).toBe(18);
    expect(gst.totalAmount).toBe(118);
  });

  it("backs tax out of the price when the rate card is inclusive", () => {
    const gst = applyGst(118, { enabled: true, percent: 18, inclusive: true });

    // The customer pays exactly what they were quoted, and the tax is derived.
    expect(gst.totalAmount).toBe(118);
    expect(gst.taxableAmount).toBe(100);
    expect(gst.gstAmount).toBe(18);
  });

  it("splits into halves that always sum back to the total", () => {
    // An odd paise total is where naive halve-and-round loses a paisa.
    const gst = applyGst(45.55, { enabled: true, percent: 18 });

    expect(Math.round((gst.cgst + gst.sgst) * 100)).toBe(Math.round(gst.gstAmount * 100));
    expect(Math.round((gst.taxableAmount + gst.gstAmount) * 100)).toBe(
      Math.round(gst.totalAmount * 100),
    );
  });

  it("charges nothing when GST is switched off", () => {
    const gst = applyGst(250, { enabled: false, percent: 18 });

    expect(gst.gstAmount).toBe(0);
    expect(gst.totalAmount).toBe(250);
    expect(gst.taxableAmount).toBe(250);
  });

  it("charges nothing when enabled with no rate, rather than inventing one", () => {
    const gst = applyGst(250, { enabled: true, percent: 0 });

    expect(gst.gstAmount).toBe(0);
    expect(gst.totalAmount).toBe(250);
  });

  it("treats a malformed rate as zero rather than falling back to a default", () => {
    // A half-written config must under-charge, never invent tax the operation
    // then owes but never collected.
    expect(normalizeGstConfig({ enabled: true, percent: "abc" }).percent).toBe(0);
    expect(applyGst(100, { enabled: true, percent: "abc" }).gstAmount).toBe(0);
  });

  it("clamps a nonsensical rate into range", () => {
    expect(normalizeGstConfig({ percent: 250 }).percent).toBe(100);
    expect(normalizeGstConfig({ percent: -5 }).percent).toBe(0);
  });

  it("reads a stored breakdown back rather than recomputing it", () => {
    // An admin changing the live rate must not change what an old booking
    // says was charged.
    const stored = gstFromBreakdown({
      taxableAmount: 200,
      gstAmount: 24,
      cgst: 12,
      sgst: 12,
      gstPercent: 12,
      fare: 224,
    });

    expect(stored.gstPercent).toBe(12);
    expect(stored.gstAmount).toBe(24);
    expect(stored.totalAmount).toBe(224);
  });

  it("reports zero tax for a booking made before GST existed", () => {
    const legacy = gstFromBreakdown({ fare: 180 });

    expect(legacy.gstAmount).toBe(0);
    expect(legacy.taxableAmount).toBe(180);
    expect(legacy.gstEnabled).toBe(false);
  });
});

describe("outstation multi-day fare with GST", () => {
  const daily = {
    baseFare: 0,
    distanceFare: 50,
    weightFare: 15,
    platformCharge: 10,
    courierCharge: 10,
    expressCharge: 0,
    fare: 75,
  };

  it("taxes the single shipment once, whatever the pickup window", () => {
    const priced = applyBillableDaysToFare(daily, 7, { enabled: true, percent: 18 });

    // 75 taxable; 18% of 75 = 13.50, gross 88.50 — rounded up to 89 for
    // collection. The 0.50 gap is its own `roundOff`, not extra tax.
    expect(priced.taxableAmount).toBe(75);
    expect(priced.gstAmount).toBe(13.5);
    expect(priced.roundOff).toBe(0.5);
    expect(priced.fare).toBe(89);
  });

  it("keeps the daily line items pre-tax so rider payout is unaffected", () => {
    const priced = applyBillableDaysToFare(daily, 7, { enabled: true, percent: 18 });

    // Rider share is computed from these, so tax must not leak into them.
    expect(priced.distanceFare).toBe(50);
    expect(priced.dailyFare).toBe(75);
  });

  it("leaves the fare untouched when no GST config is passed", () => {
    const priced = applyBillableDaysToFare(daily, 2);

    expect(priced.gstAmount).toBe(0);
    expect(priced.fare).toBe(75);
  });
});

describe("porter payment state transitions", () => {
  it("allows the normal path to capture", () => {
    expect(canTransitionPorterPayment(P.CREATED, P.PENDING)).toBe(true);
    expect(canTransitionPorterPayment(P.PENDING, P.AUTHORIZED)).toBe(true);
    expect(canTransitionPorterPayment(P.AUTHORIZED, P.CAPTURED)).toBe(true);
  });

  it("refuses to drag a captured payment back to failed", () => {
    // Razorpay does deliver payment.failed after payment.captured on a
    // retried checkout. Without this, a redelivery flips a paid booking
    // back to unpaid.
    expect(canTransitionPorterPayment(P.CAPTURED, P.FAILED)).toBe(false);
    expect(canTransitionPorterPayment(P.CAPTURED, P.PENDING)).toBe(false);
  });

  it("refuses to resurrect a failed or cancelled attempt", () => {
    expect(canTransitionPorterPayment(P.FAILED, P.CAPTURED)).toBe(false);
    expect(canTransitionPorterPayment(P.CANCELLED, P.CAPTURED)).toBe(false);
  });

  it("allows a captured payment to be refunded, in full or in part", () => {
    expect(canTransitionPorterPayment(P.CAPTURED, P.REFUNDED)).toBe(true);
    expect(canTransitionPorterPayment(P.CAPTURED, P.PARTIALLY_REFUNDED)).toBe(true);
    expect(canTransitionPorterPayment(P.PARTIALLY_REFUNDED, P.REFUNDED)).toBe(true);
  });

  it("treats a repeat of the same status as allowed, so a replay is a no-op", () => {
    expect(canTransitionPorterPayment(P.CAPTURED, P.CAPTURED)).toBe(true);
  });

  it("maps gateway statuses onto the coarse field the apps render", () => {
    expect(bookingPaymentStatusFor(P.CAPTURED)).toBe("PAID");
    // A partial refund still means the customer paid; the booking is not
    // suddenly unpaid because some money went back.
    expect(bookingPaymentStatusFor(P.PARTIALLY_REFUNDED)).toBe("PAID");
    expect(bookingPaymentStatusFor(P.REFUNDED)).toBe("REFUNDED");
    expect(bookingPaymentStatusFor(P.FAILED)).toBe("FAILED");
    // Authorised is not paid: the money is held, not taken.
    expect(bookingPaymentStatusFor(P.AUTHORIZED)).toBe("PENDING");
    expect(bookingPaymentStatusFor(P.PENDING)).toBe("PENDING");
  });
});
