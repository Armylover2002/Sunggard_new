import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * A booking nobody paid for is not a booking.
 *
 * Outstation parcel bookings write their row before the customer pays,
 * because Razorpay needs something to hang an order id off. Until the visibility
 * rule under test existed, that row was indistinguishable from a real
 * booking everywhere it was counted: a customer who opened the pay sheet
 * twice and walked away saw two live "Booked" waybills in their history,
 * the admin console offered them as REQUESTED jobs to assign a rider to,
 * and the porter-customer desk reported "2 total bookings" next to a
 * lifetime spend of zero.
 *
 * What matters and is asserted here is which rows the predicate matches —
 * getting that wrong in the other direction would hide real bookings, which
 * is the worse failure of the two.
 */

const parcelDeleteMany = jest.fn(async () => ({ deletedCount: 0 }));
const parcelEventDeleteMany = jest.fn(async () => ({ deletedCount: 0 }));

/** find(...).select().limit().lean() resolving to whatever the test queued. */
const finder = (rows) => ({
  select: () => ({ limit: () => ({ lean: async () => rows }) }),
});

const parcelFind = jest.fn(() => finder([]));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: { find: parcelFind, deleteMany: parcelDeleteMany },
}));
jest.unstable_mockModule("../app/models/parcelEvent.js", () => ({
  default: { deleteMany: parcelEventDeleteMany },
}));

const {
  PARCEL_AWAITING_PAYMENT,
  visibleParcels,
  excludeAwaitingPayment,
  sweepAbandonedCheckouts,
} = await import("../app/services/bookingCheckoutService.js");

/**
 * Minimal stand-in for how Mongo reads a `$nor` filter, so a test can ask
 * "would this document survive the filter?" without a database.
 *
 * Only the operators the predicates actually use are implemented — an
 * unknown one throws rather than quietly passing, so a future clause added
 * to the predicate cannot slip past this file untested.
 */
function matchesClause(doc, clause) {
  return Object.entries(clause).every(([field, expected]) => {
    const actual = doc[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const ops = Object.keys(expected);
      const unknown = ops.filter((op) => !["$ne", "$in", "$lt", "$gte"].includes(op));
      if (unknown.length) throw new Error(`unsupported operator: ${unknown.join(", ")}`);
      return ops.every((op) => {
        if (op === "$ne") return actual !== expected.$ne;
        if (op === "$in") return expected.$in.includes(actual);
        if (op === "$lt") return actual < expected.$lt;
        return actual >= expected.$gte;
      });
    }
    return actual === expected;
  });
}

const survives = (doc, filter) => {
  const nor = filter.$nor || [];
  const rest = Object.fromEntries(
    Object.entries(filter).filter(([key]) => key !== "$nor"),
  );
  return (
    matchesClause(doc, rest) && !nor.some((clause) => matchesClause(doc, clause))
  );
};

const outstationBooking = (overrides = {}) => ({
  customerId: "c1",
  status: "REQUESTED",
  paymentStatus: "PENDING",
  paymentMethod: "UPI",
  ...overrides,
});

describe("outstation parcel checkout visibility", () => {
  const filter = visibleParcels({ customerId: "c1" });

  it("hides a UPI booking whose payment sheet is still open", () => {
    expect(survives(outstationBooking(), filter)).toBe(false);
  });

  it("shows it once the signature has been verified", () => {
    expect(survives(outstationBooking({ paymentStatus: "PAID" }), filter)).toBe(true);
  });

  /**
   * The reason this predicate is narrower than the city one. CARD and WALLET
   * bookings are activated by createParcel without a gateway sheet and sit
   * at paymentStatus PENDING quite legitimately; a search that nobody
   * accepts then drops them back to REQUESTED. Matching on "not COD" the way
   * the city rule does would make both of those real bookings disappear.
   */
  it.each(["CARD", "WALLET", "COD"])(
    "never hides a %s booking parked back at REQUESTED",
    (paymentMethod) => {
      expect(
        survives(
          outstationBooking({ paymentMethod, paymentStatus: "PENDING" }),
          filter,
        ),
      ).toBe(true);
    },
  );

  it("keeps the caller's own conditions", () => {
    expect(
      survives(outstationBooking({ customerId: "someone-else" }), filter),
    ).toBe(false);
  });
});

describe("excludeAwaitingPayment", () => {
  it("keeps a $nor the caller already had", () => {
    const filter = excludeAwaitingPayment(
      { $nor: [{ status: "CANCELLED" }] },
      PARCEL_AWAITING_PAYMENT,
    );
    expect(filter.$nor).toHaveLength(2);
    expect(survives(outstationBooking({ status: "CANCELLED" }), filter)).toBe(false);
    expect(survives(outstationBooking({ paymentStatus: "PAID" }), filter)).toBe(true);
  });
});

describe("sweepAbandonedCheckouts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    parcelFind.mockImplementation(() => finder([]));
  });

  it("only looks at unpaid rows older than the TTL", async () => {
    await sweepAbandonedCheckouts();

    const [parcelQuery] = parcelFind.mock.calls[0];
    expect(parcelQuery).toMatchObject(PARCEL_AWAITING_PAYMENT);
    expect(parcelQuery.createdAt.$lt).toBeInstanceOf(Date);
    expect(parcelQuery.createdAt.$lt.getTime()).toBeLessThan(Date.now());
  });

  it("takes the timeline rows with the booking, and reports what it removed", async () => {
    const parcelId = new mongoose.Types.ObjectId();
    parcelFind.mockImplementation(() => finder([{ _id: parcelId }]));
    parcelDeleteMany.mockResolvedValueOnce({ deletedCount: 1 });

    const result = await sweepAbandonedCheckouts();

    expect(parcelEventDeleteMany).toHaveBeenCalledWith({
      parcelId: { $in: [parcelId] },
    });
    expect(result).toEqual({ parcels: 1 });
  });

  it("does not touch anything when there is nothing stale", async () => {
    await sweepAbandonedCheckouts();

    expect(parcelDeleteMany).not.toHaveBeenCalled();
  });

  /**
   * A hiccup mid-sweep must not throw past the caller — the sweep runs
   * unattended on a schedule, so a Mongo blip should be swallowed and simply
   * reported as nothing removed rather than crash the scheduler.
   */
  it("reports nothing removed when the query throws", async () => {
    parcelFind.mockImplementation(() => {
      throw new Error("mongo is having a moment");
    });

    const result = await sweepAbandonedCheckouts();

    expect(result).toEqual({ parcels: 0 });
  });
});
