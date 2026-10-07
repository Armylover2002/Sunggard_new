import { computeParcelDailyFare, applyBillableDaysToFare } from "../app/utils/parcelFare.js";

describe("admin-configured Express charge", () => {
  const config = { fixedDeliveryCharge: 40, weightCharge: 0, expressCharge: 25 };

  it("is not charged on a normal (non-Express) booking", () => {
    const daily = computeParcelDailyFare({ config, courierCharge: 0, weightKg: 1, isExpress: false });
    expect(daily.expressCharge).toBe(0);
    expect(daily.fare).toBe(40);
  });

  it("is added to the fare when the booking is Express", () => {
    const daily = computeParcelDailyFare({ config, courierCharge: 0, weightKg: 1, isExpress: true });
    expect(daily.expressCharge).toBe(25);
    expect(daily.fare).toBe(65); // 40 base + 25 express
  });

  it("costs nothing extra once the admin sets it to 0, even with Express selected", () => {
    const freeConfig = { ...config, expressCharge: 0 };
    const daily = computeParcelDailyFare({ config: freeConfig, courierCharge: 0, weightKg: 1, isExpress: true });
    expect(daily.expressCharge).toBe(0);
    expect(daily.fare).toBe(40);
  });

  it("defaults to not-Express when the flag is omitted — existing call sites are unaffected", () => {
    const daily = computeParcelDailyFare({ config, courierCharge: 0, weightKg: 1 });
    expect(daily.expressCharge).toBe(0);
  });

  it("carries through applyBillableDaysToFare into the GST-inclusive total and taxable amount", () => {
    const daily = computeParcelDailyFare({ config, courierCharge: 0, weightKg: 1, isExpress: true });
    const priced = applyBillableDaysToFare(daily, 1, { enabled: true, percent: 18 });

    expect(priced.expressCharge).toBe(25);
    // 65 pre-tax -> GST applied and rounded up; the express charge is part
    // of what gets taxed, not added on top afterward.
    expect(priced.fare).toBeGreaterThan(65);
    // ceilGstTotal rounds the final total up to a whole rupee and tracks the
    // difference separately as roundOff, rather than folding it back into
    // the taxable/GST split — see utils/gst.js.
    expect(priced.taxableAmount + priced.gstAmount + priced.roundOff).toBeCloseTo(priced.fare, 2);
  });
});
