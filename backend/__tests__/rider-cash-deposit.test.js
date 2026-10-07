import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * The rider COD cash loop: collect -> deposit -> admin approves -> cleared.
 *
 * These cover the rules that actually protect money: the deposit amount comes
 * from the bookings the rider holds rather than from the request body, a job
 * already named by a pending deposit cannot be claimed twice, and nothing
 * reaches REMITTED_TO_ADMIN without an approval.
 */

const RIDER_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_ID = new mongoose.Types.ObjectId().toString();
const PARCEL_ID = new mongoose.Types.ObjectId().toString();
const PARCEL_ID_2 = new mongoose.Types.ObjectId().toString();

/** Mongoose query builders are chainable; the tests only need the tail value. */
const chain = (result) => {
  const q = {
    select: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    populate: () => q,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};

const parcelFind = jest.fn();
const parcelUpdateMany = jest.fn();
const parcelAggregate = jest.fn().mockResolvedValue([]);
const depositFind = jest.fn();
const depositCreate = jest.fn();
const depositFindById = jest.fn();
const depositCountDocuments = jest.fn().mockResolvedValue(0);
const depositAggregate = jest.fn().mockResolvedValue([]);
const deliveryFind = jest.fn();
const deliveryFindById = jest.fn(() => chain(null));
const notificationCreate = jest.fn().mockResolvedValue({});
const transactionFindOneAndUpdate = jest.fn().mockResolvedValue({});
const transactionUpdateMany = jest.fn().mockResolvedValue({});

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: { find: parcelFind, updateMany: parcelUpdateMany, aggregate: parcelAggregate },
}));
jest.unstable_mockModule("../app/models/cashDeposit.js", () => ({
  default: {
    find: depositFind,
    create: depositCreate,
    findById: depositFindById,
    countDocuments: depositCountDocuments,
    aggregate: depositAggregate,
  },
}));
jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { find: deliveryFind, findById: deliveryFindById },
}));
jest.unstable_mockModule("../app/models/notification.js", () => ({
  default: { create: notificationCreate },
}));
jest.unstable_mockModule("../app/models/transaction.js", () => ({
  default: { findOneAndUpdate: transactionFindOneAndUpdate, updateMany: transactionUpdateMany },
}));
// getRiderCashStatus (called inside reviewCashDeposit) reads Setting directly;
// left unmocked it buffers against a real Mongoose connection for 10s before
// giving up, racing past this test file's 5s-per-test limit.
jest.unstable_mockModule("../app/models/setting.js", () => ({
  default: { findOne: jest.fn(() => chain(null)), findOneAndUpdate: jest.fn(() => chain(null)) },
}));

const {
  getRiderCodSummary,
  createCashDeposit,
  reviewCashDeposit,
  getFleetCashHoldings,
} = await import("../app/services/riderCashService.js");

/** Two outstation parcels the rider is holding COD cash for: 250 and 120. */
function stubHeldJobs({ pendingDeposits = [] } = {}) {
  parcelFind.mockReturnValue(
    chain([
      {
        _id: PARCEL_ID,
        fare: 300,
        codSettlement: { collectAmount: 250, status: "RIDER_HOLDING", riderCollectedAt: new Date("2026-01-01") },
        status: "DELIVERED",
        createdAt: new Date("2026-01-01"),
      },
      {
        _id: PARCEL_ID_2,
        fare: 120,
        codSettlement: { collectAmount: 120, status: "RIDER_HOLDING", riderCollectedAt: new Date("2026-01-02") },
        status: "DELIVERED",
        createdAt: new Date("2026-01-02"),
      },
    ]),
  );
  // Called twice inside the summary: once for the locked ref ids, once for
  // the pending-deposit count.
  depositFind.mockReturnValue(chain(pendingDeposits));
}

beforeEach(() => {
  jest.clearAllMocks();
  depositCountDocuments.mockResolvedValue(0);
  depositAggregate.mockResolvedValue([]);
  transactionFindOneAndUpdate.mockResolvedValue({});
  transactionUpdateMany.mockResolvedValue({});
  notificationCreate.mockResolvedValue({});
});

describe("getRiderCodSummary", () => {
  it("totals COD cash across every held job, oldest job first", async () => {
    stubHeldJobs();

    const summary = await getRiderCodSummary(RIDER_ID);

    expect(summary.depositableAmount).toBe(370);
    expect(summary.totalHeld).toBe(370);
    expect(summary.awaitingReviewAmount).toBe(0);
    expect(summary.items.map((i) => i.kind)).toEqual(["parcel", "parcel"]);
    expect(summary.items[0].amount).toBe(250);
  });

  it("hides jobs a pending deposit already claims so they cannot be deposited twice", async () => {
    stubHeldJobs({ pendingDeposits: [{ amount: 250, items: [{ refId: PARCEL_ID }] }] });

    const summary = await getRiderCodSummary(RIDER_ID);

    expect(summary.depositableAmount).toBe(120);
    expect(summary.awaitingReviewAmount).toBe(250);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].kind).toBe("parcel");
    expect(String(summary.items[0].refId)).toBe(PARCEL_ID_2);
  });

  it("falls back to the fare when no COD amount was snapshotted", async () => {
    parcelFind.mockReturnValue(
      chain([
        {
          _id: PARCEL_ID,
          fare: 400,
          codSettlement: { status: "WITH_SELLER" },
          createdAt: new Date("2026-01-01"),
        },
      ]),
    );
    depositFind.mockReturnValue(chain([]));

    const summary = await getRiderCodSummary(RIDER_ID);

    expect(summary.depositableAmount).toBe(400);
  });
});

describe("createCashDeposit", () => {
  it("sums the amount from held jobs rather than trusting the request", async () => {
    stubHeldJobs();
    depositCreate.mockImplementation(async (doc) => ({ ...doc, toObject: () => doc }));

    const deposit = await createCashDeposit({
      riderId: RIDER_ID,
      method: "UPI",
      reference: "UTR12345",
    });

    expect(deposit.amount).toBe(370);
    expect(deposit.status).toBe("PENDING");
    expect(deposit.items).toHaveLength(2);
  });

  it("deposits only the jobs the rider selected", async () => {
    stubHeldJobs();
    depositCreate.mockImplementation(async (doc) => ({ ...doc, toObject: () => doc }));

    const deposit = await createCashDeposit({
      riderId: RIDER_ID,
      method: "CASH",
      selection: [{ refId: PARCEL_ID_2 }],
    });

    expect(deposit.amount).toBe(120);
    expect(deposit.items).toHaveLength(1);
    expect(String(deposit.items[0].refId)).toBe(PARCEL_ID_2);
  });

  it("refuses an electronic transfer with neither reference nor proof", async () => {
    stubHeldJobs();

    await expect(
      createCashDeposit({ riderId: RIDER_ID, method: "BANK_TRANSFER" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(depositCreate).not.toHaveBeenCalled();
  });

  it("allows a cash handover with no reference, because the admin still reviews it", async () => {
    stubHeldJobs();
    depositCreate.mockImplementation(async (doc) => ({ ...doc, toObject: () => doc }));

    await expect(
      createCashDeposit({ riderId: RIDER_ID, method: "CASH" }),
    ).resolves.toMatchObject({ amount: 370 });
  });

  it("refuses when the rider is holding nothing", async () => {
    parcelFind.mockReturnValue(chain([]));
    depositFind.mockReturnValue(chain([]));

    await expect(
      createCashDeposit({ riderId: RIDER_ID, method: "UPI", reference: "X" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses when none of the selected jobs are still available", async () => {
    stubHeldJobs();

    await expect(
      createCashDeposit({
        riderId: RIDER_ID,
        method: "UPI",
        reference: "X",
        selection: [{ refId: new mongoose.Types.ObjectId().toString() }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("reviewCashDeposit", () => {
  const buildDeposit = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    riderId: new mongoose.Types.ObjectId(RIDER_ID),
    amount: 370,
    method: "UPI",
    status: "PENDING",
    items: [
      { kind: "parcel", refId: new mongoose.Types.ObjectId(PARCEL_ID), amount: 250 },
      { kind: "parcel", refId: new mongoose.Types.ObjectId(PARCEL_ID_2), amount: 120 },
    ],
    adminNote: "",
    save: jest.fn().mockResolvedValue(true),
    toObject() {
      return { ...this };
    },
    ...overrides,
  });

  it("approving is what moves the covered bookings to REMITTED_TO_ADMIN", async () => {
    const deposit = buildDeposit();
    depositFindById.mockResolvedValue(deposit);
    parcelUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await reviewCashDeposit({
      depositId: String(deposit._id),
      adminId: ADMIN_ID,
      approve: true,
    });

    expect(result.parcelsRemitted).toBe(2);
    expect(deposit.status).toBe("APPROVED");

    const [parcelFilter, parcelUpdate] = parcelUpdateMany.mock.calls[0];
    // Scoped to still-held bookings, so a job settled another way in the
    // meantime is skipped instead of double-counted.
    expect(parcelFilter["codSettlement.status"].$in).toEqual([
      "RIDER_HOLDING",
      "WITH_SELLER",
    ]);
    expect(parcelUpdate.$set["codSettlement.status"]).toBe("REMITTED_TO_ADMIN");
    expect(parcelUpdate.$set.paymentStatus).toBe("PAID");
  });

  it("mirrors an approval onto the legacy cash ledger the admin screens read", async () => {
    const deposit = buildDeposit();
    depositFindById.mockResolvedValue(deposit);
    parcelUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await reviewCashDeposit({ depositId: String(deposit._id), adminId: ADMIN_ID, approve: true });

    const [filter, update, options] = transactionFindOneAndUpdate.mock.calls[0];
    // Deterministic reference + upsert, so re-approving cannot double-credit.
    expect(filter.reference).toBe(`CSH-DEP-${String(deposit._id)}`);
    expect(options.upsert).toBe(true);
    expect(update.$set.amount).toBe(-370);
    expect(update.$setOnInsert.type).toBe("Cash Settlement");
  });

  it("rejecting leaves every booking held and tells the rider why", async () => {
    const deposit = buildDeposit();
    depositFindById.mockResolvedValue(deposit);

    const result = await reviewCashDeposit({
      depositId: String(deposit._id),
      adminId: ADMIN_ID,
      approve: false,
      adminNote: "Screenshot is unreadable",
    });

    expect(deposit.status).toBe("REJECTED");
    expect(result.parcelsRemitted).toBe(0);
    expect(parcelUpdateMany).not.toHaveBeenCalled();
    expect(transactionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(notificationCreate.mock.calls[0][0].message).toContain("Screenshot is unreadable");
  });

  it("refuses to review the same deposit twice", async () => {
    depositFindById.mockResolvedValue(buildDeposit({ status: "APPROVED" }));

    await expect(
      reviewCashDeposit({ depositId: String(new mongoose.Types.ObjectId()), approve: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns null for an id that is not a deposit", async () => {
    depositFindById.mockResolvedValue(null);
    await expect(
      reviewCashDeposit({ depositId: String(new mongoose.Types.ObjectId()), approve: true }),
    ).resolves.toBeNull();
  });
});

describe("getFleetCashHoldings", () => {
  it("rolls up a rider's held outstation jobs into one row", async () => {
    parcelAggregate.mockResolvedValue([{ _id: RIDER_ID, amount: 370, count: 2 }]);
    deliveryFind.mockReturnValue(
      chain([{ _id: RIDER_ID, name: "Asha", phone: "9990001111", isOnline: true }]),
    );

    const result = await getFleetCashHoldings();

    expect(result.totalHeld).toBe(370);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Asha", heldAmount: 370, heldJobs: 2 });
  });

  it("returns an empty view rather than querying riders when nobody holds cash", async () => {
    parcelAggregate.mockResolvedValue([]);

    const result = await getFleetCashHoldings();

    expect(result).toEqual({ items: [], totalHeld: 0 });
    expect(deliveryFind).not.toHaveBeenCalled();
  });
});
