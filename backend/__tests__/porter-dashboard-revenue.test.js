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
    find: mockParcelFind,
  },
}));

jest.unstable_mockModule("../app/models/deliveryZone.js", () => ({
  default: { countDocuments: jest.fn().mockResolvedValue(0) },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { countDocuments: jest.fn().mockResolvedValue(0) },
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

    const courierPipeline = mockParcelAggregate.mock.calls.at(-1)[0];
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
