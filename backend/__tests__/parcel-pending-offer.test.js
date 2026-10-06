import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockDeliveryFindById = jest.fn();
const mockParcelFind = jest.fn();
const mockParcelFindById = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockParcelUpdateOne = jest.fn();
const mockGetSearchSettings = jest.fn().mockResolvedValue({ baseSearchRadiusKm: 5, deliveryRadiusKm: 5 });
const mockHasActiveJob = jest.fn().mockResolvedValue(false);
const mockAssertCanTakeJobs = jest.fn().mockResolvedValue({ allowed: true });
const mockEmitToDelivery = jest.fn();
const mockRetractBroadcast = jest.fn().mockResolvedValue({});
const mockRetractForRider = jest.fn().mockResolvedValue({});

const chain = (result) => {
  const c = {};
  for (const m of ["populate", "select", "sort", "limit", "lean"]) c[m] = () => c;
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: mockDeliveryFindById },
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    find: mockParcelFind,
    findById: mockParcelFindById,
    findOneAndUpdate: mockParcelFindOneAndUpdate,
    updateOne: mockParcelUpdateOne,
  },
}));

jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({
  default: { getSearchSettings: mockGetSearchSettings },
}));

jest.unstable_mockModule("../app/services/deliveryBusyService.js", () => ({
  deliveryPartnerHasActiveJob: mockHasActiveJob,
  markDeliveryPartnerBusy: jest.fn(),
  syncDeliveryPartnerBusyFlag: jest.fn(),
}));

jest.unstable_mockModule("../app/services/porter/riderCashLimitService.js", () => ({
  assertRiderCanTakeJobs: mockAssertCanTakeJobs,
  filterRidersWithCashHeadroom: jest.fn(async (ids) => ids),
}));

jest.unstable_mockModule("../app/services/deliveryNearbyService.js", () => ({
  getParcelRidersNearPickupSortedByDistance: jest.fn(async () => []),
  getParcelRiderIdsNearPickup: jest.fn(async () => []),
}));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitParcelBroadcast: jest.fn(async () => ({ ids: [] })),
  retractParcelBroadcast: mockRetractBroadcast,
  retractParcelOfferForRider: mockRetractForRider,
  emitToDelivery: mockEmitToDelivery,
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToSeller: jest.fn(),
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: jest.fn(),
}));

jest.unstable_mockModule("../app/services/parcelEventService.js", () => ({
  recordParcelEvent: jest.fn(async () => null),
  PARCEL_EVENT_ACTOR: { CUSTOMER: "customer", DELIVERY: "delivery", ADMIN: "admin", SYSTEM: "system" },
}));

jest.unstable_mockModule("../app/config/redis.js", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

const {
  fetchAvailableParcelsForRider,
  parcelAcceptAtomic,
  processParcelSearchTimeout,
} = await import("../app/services/parcelWorkflowService.js");

const RIDER = new mongoose.Types.ObjectId();
const PARCEL = new mongoose.Types.ObjectId();

describe("pending offers after a timeout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParcelFindOneAndUpdate.mockReturnValue(chain(null));
    // Pickup sits right on the rider, so the radius check passes.
    mockParcelFindById.mockReturnValue(
      chain({ _id: PARCEL, status: "SEARCHING", pickupAddress: { lat: 28, lng: 77 }, zoneId: null }),
    );
    mockParcelFind.mockReturnValue(chain([]));
    mockParcelUpdateOne.mockResolvedValue({});
    mockDeliveryFindById.mockReturnValue(
      chain({ isParcelService: true, isVerified: true, isOnline: true, location: { coordinates: [77, 28] }, zoneIds: [] }),
    );
  });

  it("accept lets the live offered rider or a timed-out (pending) rider claim it", async () => {
    await parcelAcceptAtomic(RIDER.toString(), PARCEL.toString(), null).catch(() => {});

    const filter = mockParcelFindOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toBe("SEARCHING");
    expect(filter.deliveryPartnerId).toBeNull();
    expect(filter.$or).toEqual([
      { "searchMeta.offeredTo": RIDER, searchExpiresAt: { $gt: expect.any(Date) } },
      { offerTimeoutBy: RIDER },
    ]);
    expect(filter.skippedBy).toEqual({ $nin: [RIDER] });
  });

  it("pull feed shows the live offer and the rider's pending requests, not rejected ones", async () => {
    await fetchAvailableParcelsForRider(RIDER.toString());

    const filter = mockParcelFind.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { "searchMeta.offeredTo": RIDER, searchExpiresAt: { $gt: expect.any(Date) } },
      { offerTimeoutBy: RIDER },
    ]);
    expect(filter.skippedBy).toEqual({ $ne: RIDER });
    expect(filter).not.toHaveProperty("offerTimeoutBy");
  });

  it("a timeout moves the request to the rider's pending list without withdrawing other riders' rows", async () => {
    const parcel = {
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      searchExpiresAt: new Date(Date.now() - 1000),
      searchMeta: { offeredTo: RIDER },
      pickupAddress: {},
      dropAddress: {},
    };
    mockParcelFindById.mockReturnValue(chain(parcel));

    await processParcelSearchTimeout(PARCEL.toString());

    expect(mockParcelUpdateOne).toHaveBeenCalledWith(
      { _id: PARCEL.toString(), status: "SEARCHING" },
      expect.objectContaining({ $addToSet: { offerTimeoutBy: RIDER } }),
    );
    expect(mockEmitToDelivery).toHaveBeenCalledWith(
      RIDER,
      expect.objectContaining({ event: "parcel:pending" }),
    );
    // No other rider is in range here, so the request falls back to manual
    // assignment — that is the one place pending rows are cleared. The timeout
    // itself must not clear them (it runs before the fallback).
    expect(mockRetractBroadcast).toHaveBeenCalledTimes(1);
    const fallbackUpdate = mockParcelFindOneAndUpdate.mock.calls.at(-1)[1];
    expect(fallbackUpdate.$set.status).toBe("REQUESTED");
  });
});
