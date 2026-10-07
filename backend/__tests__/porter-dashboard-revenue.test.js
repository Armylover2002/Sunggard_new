import { jest } from "@jest/globals";

const mockParcelAggregate = jest.fn();
const mockParcelCountDocuments = jest.fn().mockResolvedValue(0);
const mockParcelFind = jest.fn(() => ({
  sort: () => ({
    limit: () => ({
      populate: () => ({
        populate: () => ({
          select: () => ({ lean: async () => [] }),
        }),
      }),
    }),
  }),
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    aggregate: mockParcelAggregate,
    countDocuments: mockParcelCountDocuments,
    distinct: jest.fn().mockResolvedValue([]),
    find: mockParcelFind,
  },
}));

jest.unstable_mockModule("../app/models/deliveryZone.js", () => ({
  default: {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  },
}));

jest.unstable_mockModule("../app/models/parcelReview.js", () => ({
  default: { aggregate: jest.fn().mockResolvedValue([]) },
}));

jest.unstable_mockModule("../app/models/cashDeposit.js", () => ({
  default: { countDocuments: jest.fn().mockResolvedValue(0) },
}));

jest.unstable_mockModule("../app/models/courierCompany.js", () => ({
  default: {
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  },
}));

jest.unstable_mockModule("../app/services/bookingCheckoutService.js", () => ({
  visibleParcels: jest.fn((window) => window),
}));

const mockTransactionAggregate = jest.fn();
jest.unstable_mockModule("../app/models/transaction.js", () => ({
  default: { aggregate: mockTransactionAggregate },
}));

const { adminGetPorterDashboard } = await import("../app/controller/porterDashboardController.js");

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("porter dashboard excludes cancelled/in-flight bookings from revenue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParcelAggregate.mockResolvedValue([]);
  });

  it("the daily trend aggregation only counts DELIVERED fare as revenue", async () => {
    const req = { query: {} };
    const res = makeRes();
    await adminGetPorterDashboard(req, res);

    // Calls in Promise.all order: [0] status breakdown, [1] DELIVERED-only
    // money totals, [2] daily trend, [last] courier company breakdown.
    const dailyPipeline = mockParcelAggregate.mock.calls[2][0];
    const dailyGroupStage = dailyPipeline.find((stage) => stage.$group)?.$group;

    expect(dailyGroupStage.count).toEqual({ $sum: 1 });
    expect(dailyGroupStage.revenue).toEqual({
      $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, "$fare", 0] },
    });
  });

  it("the courier company breakdown only charges for DELIVERED bookings", async () => {
    const req = { query: {} };
    const res = makeRes();
    await adminGetPorterDashboard(req, res);

    const courierPipeline = mockParcelAggregate.mock.calls
      .map((call) => call[0])
      .find((pipeline) => pipeline.some((stage) => stage.$group?._id === "$courierCompanyId"));
    const groupStage = courierPipeline.find((stage) => stage.$group)?.$group;

    expect(groupStage._id).toBe("$courierCompanyId");
    expect(groupStage.charge).toEqual({
      $sum: {
        $cond: [
          { $eq: ["$status", "DELIVERED"] },
          { $ifNull: ["$fareBreakdown.courierCharge", 0] },
          0,
        ],
      },
    });
    // bookings counts every booking regardless of status — that part is
    // deliberately NOT status-gated, unlike charge.
    expect(groupStage.bookings).toEqual({ $sum: 1 });
  });
});

describe("admin earning is computed, not hardcoded to revenue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("subtracts the real rider payout, and excludes courier charge and GST (pass-through)", async () => {
    const parcelId = "6ac00000000000000000ab12";
    mockParcelAggregate
      .mockResolvedValueOnce([]) // [0] status breakdown
      .mockResolvedValueOnce([
        {
          delivered: 1,
          revenue: 283,
          distanceKm: 0,
          baseFare: 50,
          weightFare: 3,
          expressCharge: 20,
          courierCharge: 210,
          gstAmount: 0,
          ids: [parcelId],
        },
      ]) // [1] pickupMoney
      .mockResolvedValueOnce([]) // [2] daily trend
      .mockResolvedValueOnce([]); // [3] courier company breakdown
    mockTransactionAggregate.mockResolvedValue([{ amount: 0.06 }]);

    const req = { query: {} };
    const res = makeRes();
    await adminGetPorterDashboard(req, res);

    // Real payout query actually scoped to this window's delivered parcels.
    expect(mockTransactionAggregate).toHaveBeenCalledWith([
      {
        $match: {
          userModel: "Delivery",
          type: "Delivery Earning",
          "meta.parcelId": { $in: [parcelId] },
        },
      },
      { $group: { _id: null, amount: { $sum: "$amount" } } },
    ]);

    const body = res.json.mock.calls[0][0];
    // 50 + 3 + 20 + 210 - 0.06 = 282.94 — courier company charge is
    // included; GST (0 here) is the only thing still excluded.
    expect(body.result.overview.adminEarning).toBe(282.94);
    expect(body.result.overview.riderPayout).toBe(0.06);
    expect(body.result.marginBreakdown).toEqual({
      deliveryCharge: 50,
      weightCharge: 3,
      expressCharge: 20,
      courierCompanyCharge: 210,
      gstCollected: 0,
      riderPayout: 0.06,
      adminEarning: 282.94,
    });
  });

  it("skips the rider-payout query entirely when nothing was delivered", async () => {
    mockParcelAggregate.mockResolvedValue([]);

    const req = { query: {} };
    const res = makeRes();
    await adminGetPorterDashboard(req, res);

    expect(mockTransactionAggregate).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.result.overview.adminEarning).toBe(0);
  });
});
