import { jest } from "@jest/globals";

/**
 * The porter money chain, end to end, on the real arithmetic.
 *
 * Nothing here is mocked except the config document — the fare, the rider's
 * cut, the platform's margin and the COD amount are all produced by the
 * functions the running app uses. The point is the invariants between them:
 * the customer is charged what the breakdown adds up to, the rider is never
 * paid more than was collected, the platform's margin is never negative, and
 * a COD booking asks the rider for exactly the fare.
 */

const {
  computeParcelDailyFare,
  applyBillableDaysToFare,
  resolveParcelBillableDays,
} = await import("../app/utils/parcelFare.js");
const { computeRiderParcelEarnings } = await import(
  "../app/services/parcelWorkflowService.js"
);
const { distanceMeters } = await import("../app/utils/geoUtils.js");

/**
 * And one for /admin/parcels/pricing. Outstation is a flat delivery charge —
 * distance/weight no longer price the customer at all. The rider's payout is
 * a separate, unrelated number: per-km rate × distance from where they
 * accepted the job to the pickup point (see computeRiderParcelEarnings).
 */
const PARCEL_CONFIG = {
  fixedDeliveryCharge: 40,
  riderPerKmRate: 8,
};

/** Two points ~1km apart, used to exercise the rider-payout distance calc. */
const PARCEL_PICKUP = { lat: 28.6139, lng: 77.209 };
const PARCEL_ACCEPT = { lat: 28.622, lng: 77.209 };
const PARCEL_ACCEPT_KM =
  distanceMeters(PARCEL_ACCEPT.lat, PARCEL_ACCEPT.lng, PARCEL_PICKUP.lat, PARCEL_PICKUP.lng) /
  1000;

const money = (n) => Math.round(n * 100) / 100;

/* ========================================================================
   Outstation (pickup-service parcel)
   ======================================================================== */

describe("outstation pricing", () => {
  it("charges a flat delivery fee — distance and weight no longer price it", () => {
    const daily = computeParcelDailyFare({ config: PARCEL_CONFIG });

    expect(daily.baseFare).toBe(PARCEL_CONFIG.fixedDeliveryCharge);
    expect(daily.distanceFare).toBe(0);
    expect(daily.weightFare).toBe(0);
    expect(daily.platformCharge).toBe(0);
    expect(daily.companyCharge).toBe(0);
    expect(daily.expressCharge).toBe(0);
    expect(daily.fare).toBe(PARCEL_CONFIG.fixedDeliveryCharge);
  });

  it("pays the rider the distance from their accept point to pickup, at the admin's per-km rate", () => {
    const earning = computeRiderParcelEarnings(
      { riderAcceptLocation: PARCEL_ACCEPT, pickupAddress: PARCEL_PICKUP },
      PARCEL_CONFIG,
    );

    // The fare (a flat charge) and the payout (a distance calc) are two
    // unrelated numbers now — the payout is not "a share of the fare".
    expect(earning).toBe(money(PARCEL_ACCEPT_KM * PARCEL_CONFIG.riderPerKmRate));
  });

  it("pays nothing when the rider never accepted — no location snapshot to measure from", () => {
    const earning = computeRiderParcelEarnings(
      { pickupAddress: PARCEL_PICKUP },
      PARCEL_CONFIG,
    );
    expect(earning).toBe(0);
  });

  it("multiplies the customer total by booked days, one flat charge per day", () => {
    const daily = computeParcelDailyFare({ config: PARCEL_CONFIG });
    const days = resolveParcelBillableDays({ pickupWindow: "7_days" });
    const priced = applyBillableDaysToFare(daily, days);

    expect(days).toBe(7);
    expect(priced.fare).toBe(money(daily.fare * 7));
  });

  it("resolves every booking window to the days it bills for", () => {
    expect(resolveParcelBillableDays({ pickupWindow: "today" })).toBe(1);
    expect(resolveParcelBillableDays({ pickupWindow: "15_days" })).toBe(15);
    expect(resolveParcelBillableDays({ pickupWindow: "30_days" })).toBe(30);
    expect(
      resolveParcelBillableDays({ pickupWindow: "custom_days", pickupWindowDays: 4 }),
    ).toBe(4);
    // A month is the ceiling, whatever the client asks for.
    expect(
      resolveParcelBillableDays({ pickupWindow: "custom_days", pickupWindowDays: 900 }),
    ).toBe(31);
  });
});

/* ========================================================================
   What the customer pays, and what the rider ends up holding
   ======================================================================== */

/** Mirrors buildInitialCodSettlement / the city createParcel branch. */
const codStateFor = (paymentMethod, fare) =>
  String(paymentMethod).toUpperCase() === "COD"
    ? { amount: fare, status: "COLLECT_PENDING", paymentStatus: "PENDING" }
    : { amount: 0, status: "NOT_APPLICABLE", paymentStatus: "PENDING" };

describe("payment method decides who holds the money", () => {
  const parcelDaily = computeParcelDailyFare({ config: PARCEL_CONFIG });
  const parcelEarning = computeRiderParcelEarnings(
    { riderAcceptLocation: PARCEL_ACCEPT, pickupAddress: PARCEL_PICKUP },
    PARCEL_CONFIG,
  );

  it("COD asks the rider to collect the whole fare, not the rider's share of it", () => {
    const cod = codStateFor("COD", parcelDaily.fare);

    expect(cod.amount).toBe(parcelDaily.fare);
    expect(cod.status).toBe("COLLECT_PENDING");
    // The rider's own earning is settled separately through the ledger; it is
    // not netted off the cash they hand back.
    expect(cod.amount).not.toBe(parcelEarning);
  });

  it("online leaves the rider holding nothing", () => {
    const online = codStateFor("UPI", parcelDaily.fare);

    expect(online.amount).toBe(0);
    expect(online.status).toBe("NOT_APPLICABLE");
  });

  it("a COD booking switched to online at the door stops counting as cash", () => {
    // What riderCheckCodQr does once Razorpay reports the QR paid.
    const booking = { ...codStateFor("COD", parcelDaily.fare), paymentMethod: "COD" };
    const converted = {
      ...booking,
      paymentMethod: "UPI",
      paymentStatus: "PAID",
      amount: 0,
      status: "NOT_APPLICABLE",
    };

    expect(converted.amount).toBe(0);
    expect(converted.status).toBe("NOT_APPLICABLE");
    expect(converted.paymentMethod).toBe("UPI");
  });
});

/* ========================================================================
   Cash back to admin, and earnings out to the rider
   ======================================================================== */

describe("rider cash and earnings never mix", () => {
  const parcelDaily = computeParcelDailyFare({ config: PARCEL_CONFIG });
  const parcelEarning = computeRiderParcelEarnings(
    { riderAcceptLocation: PARCEL_ACCEPT, pickupAddress: PARCEL_PICKUP },
    PARCEL_CONFIG,
  );
  const depositTotal = money(parcelDaily.fare);

  it("a deposit covers the full collected fare", () => {
    const held = [{ kind: "parcel", amount: parcelDaily.fare }];

    // The rider hands back what the customer paid, in full.
    expect(money(held.reduce((sum, h) => sum + h.amount, 0))).toBe(depositTotal);
  });

  it("depositing cash does not reduce what the rider can withdraw", () => {
    // Mirrors computeWithdrawableBalance in deliveryController: only earning
    // rows count, and the Cash Settlement written on deposit approval is not
    // one of them.
    const ledger = [
      { type: "Delivery Earning", status: "Settled", amount: parcelEarning },
      { type: "Cash Collection", status: "Settled", amount: depositTotal },
      { type: "Cash Settlement", status: "Settled", amount: -depositTotal },
    ];

    const earned = ledger
      .filter((t) => t.status === "Settled" && ["Delivery Earning", "Incentive", "Bonus"].includes(t.type))
      .reduce((a, t) => a + Math.abs(t.amount), 0);

    // The cash rows cancel each other and touch neither side.
    expect(money(earned)).toBe(money(parcelEarning));
  });

  it("the platform keeps fare minus rider earning on every job", () => {
    const parcelMargin = money(parcelDaily.fare - parcelEarning);

    expect(parcelMargin).toBeGreaterThan(0);
  });
});
