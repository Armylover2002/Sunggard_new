import { jest } from "@jest/globals";

/**
 * AUDIT HARNESS — coupon x GST x payment interaction across the Porter matrix.
 *
 * Runs the REAL pricing, tax and coupon engines. Only the Coupon/Parcel
 * model reads are stubbed, because the arithmetic under audit does not
 * depend on Mongo. Every expectation below is calculated by hand in the
 * comment above it, so a failure says which of the two is wrong.
 */

const findOne = jest.fn();
const findById = jest.fn();
const countDocuments = jest.fn().mockResolvedValue(0);

jest.unstable_mockModule("../app/models/coupon.js", () => ({
  default: {
    findOne: (...a) => ({ session: () => ({ lean: () => findOne(...a) }), lean: () => findOne(...a) }),
    findById: (...a) => ({ session: () => ({ lean: () => findById(...a) }), lean: () => findById(...a) }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));
jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: { countDocuments: (...a) => ({ session: () => countDocuments(...a), then: (r)=>Promise.resolve(0).then(r) }) },
}));

const { computeBookingDiscount } = await import("../app/services/finance/couponService.js");
const { computeParcelDailyFare, applyBillableDaysToFare } = await import(
  "../app/utils/parcelFare.js"
);
const { rebaseGstAfterDiscount } = await import("../app/utils/gst.js");

const money = (n) => Math.round(Number(n) * 100) / 100;

/** Rate card as an admin would save it on /admin/parcels/pricing. */
const PARCEL = { fixedDeliveryCharge: 80 };

const GST_ON = { enabled: true, percent: 18, inclusive: false, gstin: "27AAAAA0000A1Z5" };
const GST_OFF = { enabled: false, percent: 0 };

const PCT10 = {
  _id: "c1",
  code: "SAVE10",
  isActive: true,
  discountType: "percentage",
  discountValue: 10,
  appliesTo: ["porter_local", "porter_outstation"],
};

/* ======================================================================
   1. Outstation breakdown carries the tax it charged
   ====================================================================== */

describe("outstation breakdown carries the tax it charged", () => {
  it("exposes every field the booking record and GST report read", () => {
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_ON);

    // 80 taxable, 14.40 tax, 94.40 charged to the customer.
    expect(priced.fare).toBe(94.4);
    expect(priced.taxableAmount).toBe(80);
    expect(priced.gstAmount).toBe(14.4);
    expect(priced.cgst).toBe(7.2);
    expect(priced.sgst).toBe(7.2);
    expect(priced.gstPercent).toBe(18);
    expect(priced.gstin).toBe("27AAAAA0000A1Z5");
    expect(priced.gstInclusive).toBe(false);

    // The controller copies these onto `fareBreakdown`; a zero here is what
    // made outstation tax invisible to the invoice and the GST report.
    expect(priced.gstAmount).toBeGreaterThan(0);
    expect(priced.taxableAmount).toBeGreaterThan(0);
  });
});

/* ======================================================================
   2. THE CORE AUDIT — what a coupon does to the tax base
   ====================================================================== */

describe("coupon x GST: does the invoice reconcile with the tax actually due?", () => {
  beforeEach(() => {
    findOne.mockResolvedValue(PCT10);
    findById.mockResolvedValue(PCT10);
  });

  it("GST OFF + 10% coupon: discount 8.00, payable 72.00", async () => {
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_OFF);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare,
    });
    // 10% of 80 = 8.00 -> payable 72.00. No tax involved, nothing to reconcile.
    expect(d.discountAmount).toBe(8);
    expect(d.payableFare).toBe(72);
  });

  it("GST ON + 10% coupon: records the tax base and what the customer pays", async () => {
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_ON);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare, // 94.40 — the TAX-INCLUSIVE gross
    });

    // The coupon is applied to the tax-inclusive gross, so "10% off" takes
    // 9.44 rather than 10% of the pre-tax 80 (= 8.00).
    expect(d.discountAmount).toBe(9.44);
    expect(d.payableFare).toBe(84.96);

    // What gets persisted on the booking as the tax record:
    const storedTaxable = priced.taxableAmount; // 80
    const storedGst = priced.gstAmount; // 14.40

    // INVARIANT UNDER AUDIT: the tax recorded as charged should be the tax on
    // the consideration actually received. Customer paid 84.96; at 18% that
    // implies taxable 72.00 and GST 12.96.
    const impliedTaxable = money(d.payableFare / 1.18); // 72.00
    const impliedGst = money(d.payableFare - impliedTaxable); // 12.96

    expect(impliedTaxable).toBe(72);
    expect(impliedGst).toBe(12.96);

    // The gap the platform over-declares, per booking:
    const overDeclared = money(storedGst - impliedGst);
    expect(overDeclared).toBe(1.44); // == 18% of the 8.00 pre-tax discount

    // Documents the raw rate-card output before re-attribution.
    expect(storedTaxable).toBe(80);
    expect(storedGst).toBe(14.4);

    // ...and the fix puts the tax back onto the money that changed hands.
    const rebased = rebaseGstAfterDiscount(priced, d.payableFare);
    expect(rebased.taxableAmount).toBe(72);
    expect(rebased.gstAmount).toBe(12.96);
    expect(money(rebased.cgst + rebased.sgst)).toBe(12.96);
    expect(rebased.preDiscountTaxableAmount).toBe(80);
    // The invoice now closes: taxable + tax == what the customer paid.
    expect(money(rebased.taxableAmount + rebased.gstAmount)).toBe(d.payableFare);
  });

  it("a fixed-amount coupon also lands the tax on the amount paid", async () => {
    findOne.mockResolvedValue({ ...PCT10, discountType: "fixed", discountValue: 20 });
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_ON);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare,
    });
    // 94.40 - 20 = 74.40 paid. The customer total is unchanged by the fix.
    expect(d.payableFare).toBe(74.4);

    const rebased = rebaseGstAfterDiscount(priced, d.payableFare);
    // 74.40 / 1.18 = 63.05 taxable, tax 11.35.
    expect(rebased.taxableAmount).toBe(63.05);
    expect(rebased.gstAmount).toBe(11.35);
    expect(money(rebased.taxableAmount + rebased.gstAmount)).toBe(74.4);
  });

  it("with GST off, the taxable value is the discounted amount, not the list fare", async () => {
    findOne.mockResolvedValue(PCT10);
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_OFF);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare,
    });
    const rebased = rebaseGstAfterDiscount(priced, d.payableFare);
    expect(rebased.taxableAmount).toBe(72);
    expect(rebased.gstAmount).toBe(0);
    expect(rebased.preDiscountTaxableAmount).toBe(80);
  });

  it("leaves an inclusive rate card reconciling too", async () => {
    findOne.mockResolvedValue(PCT10);
    const daily = computeParcelDailyFare({ config: PARCEL });
    const inclusive = applyBillableDaysToFare(daily, 1, {
      enabled: true,
      percent: 18,
      inclusive: true,
    });
    // Inclusive: the customer pays the 80 quoted, tax backed out of it.
    expect(inclusive.fare).toBe(80);
    expect(inclusive.taxableAmount).toBe(67.8);
    expect(inclusive.gstAmount).toBe(12.2);

    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: inclusive.fare,
    });
    expect(d.payableFare).toBe(72); // 80 - 8.00

    const rebased = rebaseGstAfterDiscount(inclusive, d.payableFare);
    expect(money(rebased.taxableAmount + rebased.gstAmount)).toBe(72);
    expect(rebased.gstInclusive).toBe(true);
  });
});

/* ======================================================================
   3. Rider payout is a distance calc, independent of tax and fare
   ====================================================================== */

describe("outstation payout is a distance calc, independent of tax and fare", () => {
  it("is unaffected by GST or the fare recorded on the parcel", async () => {
    const { computeRiderParcelEarnings } = await import(
      "../app/services/parcelWorkflowService.js"
    );

    const pickupAddress = { lat: 28.6139, lng: 77.209 };
    const riderAcceptLocation = { lat: 28.622, lng: 77.209 };

    // Whatever the fare/tax on the parcel say, the payout only reads
    // riderAcceptLocation → pickupAddress distance and the configured rate —
    // a legacy row missing fareBreakdown/tax fields pays exactly the same.
    const withTax = {
      fare: 118,
      fareBreakdown: { taxableAmount: 100, gstAmount: 18 },
      pickupAddress,
      riderAcceptLocation,
    };
    const withoutTax = { fare: 80, pickupAddress, riderAcceptLocation };

    const earningWithTax = computeRiderParcelEarnings(withTax, { riderPerKmRate: 8 });
    const earningWithoutTax = computeRiderParcelEarnings(withoutTax, { riderPerKmRate: 8 });
    expect(earningWithTax).toBe(earningWithoutTax);
    expect(earningWithTax).toBeGreaterThan(0);

    // A legacy row with no accept-location snapshot at all pays nothing —
    // there is nothing to measure a distance against.
    const legacyNoSnapshot = { fare: 118, fareBreakdown: {}, pickupAddress };
    expect(computeRiderParcelEarnings(legacyNoSnapshot, { riderPerKmRate: 8 })).toBe(0);
  });
});

/* ======================================================================
   4. The whole chain: quote -> coupon -> stored booking -> invoice
   ====================================================================== */

describe("invoice reconciles end to end", () => {
  it("charges - discount + tax == the amount the customer pays", async () => {
    findOne.mockResolvedValue(PCT10);

    const daily = computeParcelDailyFare({ config: PARCEL });
    const quote = applyBillableDaysToFare(daily, 1, GST_ON);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: quote.fare,
    });

    // Exactly what the controller now persists on the booking.
    const stored = { ...quote, ...rebaseGstAfterDiscount(quote, d.payableFare) };

    // The pre-tax charge lines the invoice prints.
    const chargeLines =
      stored.baseFare + stored.distanceFare + stored.weightFare + stored.platformCharge;
    expect(money(chargeLines)).toBe(80);

    // The discount the invoice puts against those lines.
    const taxableDiscount = money(stored.preDiscountTaxableAmount - stored.taxableAmount);
    expect(taxableDiscount).toBe(8);

    // Invoice subtotal is the taxable value, and the lines resolve to it.
    expect(money(chargeLines - taxableDiscount)).toBe(stored.taxableAmount);

    // Subtotal + tax == total == what payment/COD will actually collect.
    expect(money(stored.taxableAmount + stored.gstAmount)).toBe(d.payableFare);

    // And the customer's headline saving is still the full 9.44.
    expect(d.discountAmount).toBe(9.44);
    expect(money(taxableDiscount + (stored.preDiscountTaxableAmount * 0.18 - stored.gstAmount)))
      .toBe(9.44);
  });
});

/* ======================================================================
   5. Outstation multi-day: tax on the total, not per day
   ====================================================================== */

describe("outstation fare with billable days", () => {
  it("taxes the multi-day total once", () => {
    const daily = computeParcelDailyFare({ config: PARCEL });
    // Flat delivery charge, unaffected by distance/weight — 80/day.
    expect(daily.fare).toBe(80);

    const priced = applyBillableDaysToFare(daily, 7, GST_ON);
    // 80 x 7 = 560 taxable; 18% = 100.80; gross 660.80
    expect(priced.taxableAmount).toBe(560);
    expect(priced.gstAmount).toBe(100.8);
    expect(priced.fare).toBe(660.8);
  });
});

/* ======================================================================
   6. Coupon clamps
   ====================================================================== */

describe("coupon clamps", () => {
  it("a fixed coupon larger than the fare cannot make the payable negative", async () => {
    findOne.mockResolvedValue({
      ...PCT10,
      discountType: "fixed",
      discountValue: 10000,
    });
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_ON);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare,
    });
    expect(d.discountAmount).toBe(94.4);
    expect(d.payableFare).toBe(0);
  });

  it("honours maxDiscount", async () => {
    findOne.mockResolvedValue({ ...PCT10, discountValue: 50, maxDiscount: 20 });
    const daily = computeParcelDailyFare({ config: PARCEL });
    const priced = applyBillableDaysToFare(daily, 1, GST_ON);
    const d = await computeBookingDiscount({
      couponCode: "SAVE10",
      bookingKind: "porter_outstation",
      fareAmount: priced.fare,
    });
    // 50% of 94.40 = 47.20, clamped to 20
    expect(d.discountAmount).toBe(20);
    expect(d.payableFare).toBe(74.4);
  });

  it("rejects a coupon that does not apply to this booking kind", async () => {
    findOne.mockResolvedValue({ ...PCT10, appliesTo: ["order"] });
    await expect(
      computeBookingDiscount({
        couponCode: "SAVE10",
        bookingKind: "porter_outstation",
        fareAmount: 94.4,
      }),
    ).rejects.toThrow(/not valid for this type/i);
  });
});
