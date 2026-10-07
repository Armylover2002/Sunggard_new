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

jest.unstable_mockModule("../app/services/porter/porterRefundService.js", () => ({
  getRefundTotals: jest.fn().mockResolvedValue({
    refundedCount: 0,
    refundedAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
    failedCount: 0,
    failedAmount: 0,
  }),
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

describe("admin earning only counts cash that has reached admin", () => {
  const parcelId = "6ac00000000000000000ab12";
  const lineItems = { baseFare: 50, weightFare: 3, expressCharge: 20, courierCharge: 210, gstAmount: 0 };

  // Group output for ONE delivered parcel, with its cash either with admin
  // (r_*) or still with the rider (p_*).
  const money = (received) => {
    const out = { delivered: 1, distanceKm: 0, onlineFare: 0, parcels: [{ id: parcelId, received }] };
    for (const [key, value] of Object.entries({ ...lineItems, fare: 283 })) {
      out[`r_${key}`] = received ? value : 0;
      out[`p_${key}`] = received ? 0 : value;
    }
    return out;
  };

  const run = async ({ received, withdrawn = [] }) => {
    mockParcelAggregate.mockReset();
    mockParcelAggregate.mockImplementation(async (pipeline) =>
      pipeline.some((stage) => stage.$group?.parcels) ? [money(received)] : [],
    );
    mockTransactionAggregate.mockReset();
    mockTransactionAggregate.mockImplementation(async (pipeline) => {
      const type = pipeline[0].$match.type;
      return type === "Withdrawal" ? withdrawn : [{ _id: "rider1", amount: 0.06 }];
    });
    const res = makeRes();
    await adminGetPorterDashboard({ query: {} }, res);
    return res.json.mock.calls[0][0].result;
  };

  it("counts an online booking on delivery, minus the rider's earning, and shows it as owed until withdrawn", async () => {
    const result = await run({ received: true });
    // 50 + 3 + 20 + 210 - 0.06; GST excluded.
    expect(result.overview.adminEarning).toBe(282.94);
    expect(result.overview.cashWithRiders).toBe(0);
    expect(result.overview.riderEarned).toBe(0.06);
    expect(result.overview.riderPayout).toBe(0); // nothing withdrawn yet
    expect(result.overview.riderOwed).toBe(0.06);
    expect(result.marginBreakdown).toMatchObject({
      deliveryCharge: 50,
      weightCharge: 3,
      expressCharge: 20,
      courierCompanyCharge: 210,
      gstCollected: 0,
      riderEarning: 0.06,
      adminEarning: 282.94,
    });
  });

  it("does NOT count a COD booking while the rider still holds the cash", async () => {
    const result = await run({ received: false });
    expect(result.overview.adminEarning).toBe(0);
    expect(result.overview.pendingEarning).toBe(282.94);
    expect(result.overview.cashWithRiders).toBe(283);
    expect(result.marginBreakdown.pending).toMatchObject({ cashWithRiders: 283, earning: 282.94 });
  });

  it("only reports a rider as paid once a withdrawal has been settled", async () => {
    const result = await run({ received: true, withdrawn: [{ _id: "rider1", amount: 0.06 }] });
    expect(result.overview.riderPayout).toBe(0.06);
    expect(result.overview.riderOwed).toBe(0);
  });

  it("skips the rider-earning lookup entirely when nothing was delivered", async () => {
    mockParcelAggregate.mockReset();
    mockParcelAggregate.mockResolvedValue([]);
    mockTransactionAggregate.mockReset();
    const res = makeRes();
    await adminGetPorterDashboard({ query: {} }, res);

    expect(mockTransactionAggregate).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].result.overview.adminEarning).toBe(0);
  });
});
