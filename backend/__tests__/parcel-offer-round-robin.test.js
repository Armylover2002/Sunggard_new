import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockParcelFindById = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockGetSearchSettings = jest.fn().mockResolvedValue({ deliveryRadiusKm: 5 });
const mockGetActiveZoneById = jest.fn().mockResolvedValue(null);
const mockGetSorted = jest.fn();
const mockEmitParcelBroadcast = jest.fn().mockResolvedValue({ ids: [] });
const mockRetractBroadcast = jest.fn().mockResolvedValue({});
const mockFilterCashHeadroom = jest.fn(async (ids) => ids);
const mockRecordEvent = jest.fn(async () => null);

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    findById: mockParcelFindById,
    findOneAndUpdate: mockParcelFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({
  default: { getSearchSettings: mockGetSearchSettings },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: jest.fn() },
}));

jest.unstable_mockModule("../app/services/deliveryNearbyService.js", () => ({
  getParcelRidersNearPickupSortedByDistance: mockGetSorted,
  getParcelRiderIdsNearPickup: jest.fn(async () => []),
}));

jest.unstable_mockModule("../app/services/deliveryZoneService.js", () => ({
  getActiveZoneById: mockGetActiveZoneById,
  isPointInZoneId: jest.fn(async () => true),
}));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitParcelBroadcast: mockEmitParcelBroadcast,
  retractParcelBroadcast: mockRetractBroadcast,
  retractParcelOfferForRider: jest.fn().mockResolvedValue({}),
  emitToDelivery: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToSeller: jest.fn(),
}));

jest.unstable_mockModule("../app/services/sellerNearbyService.js", () => ({
  findNearestParcelSellerNearPickup: jest.fn(async () => null),
  getApprovedParcelSeller: jest.fn(async () => null),
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: jest.fn(),
}));

jest.unstable_mockModule("../app/services/deliveryBusyService.js", () => ({
  deliveryPartnerHasActiveJob: jest.fn(async () => false),
  markDeliveryPartnerBusy: jest.fn(),
  syncDeliveryPartnerBusyFlag: jest.fn(),
}));

jest.unstable_mockModule("../app/services/parcelEventService.js", () => ({
  recordParcelEvent: mockRecordEvent,
  PARCEL_EVENT_ACTOR: { CUSTOMER: "customer", DELIVERY: "delivery", ADMIN: "admin", SYSTEM: "system" },
}));

jest.unstable_mockModule("../app/services/porter/riderCashLimitService.js", () => ({
  assertRiderCanTakeJobs: jest.fn(async () => ({ allowed: true })),
  filterRidersWithCashHeadroom: mockFilterCashHeadroom,
}));

jest.unstable_mockModule("../app/config/redis.js", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

const { offerParcelToNextRider } = await import("../app/services/parcelWorkflowService.js");

const PARCEL = new mongoose.Types.ObjectId();
const RIDER_A = new mongoose.Types.ObjectId();
const RIDER_B = new mongoose.Types.ObjectId();

describe("sequential offers cycle back when nobody acts, instead of running out", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSorted.mockResolvedValue([
      { id: String(RIDER_A), distanceM: 100 },
      { id: String(RIDER_B), distanceM: 200 },
    ]);
    mockParcelFindOneAndUpdate.mockImplementation((filter, update) => ({
      _id: PARCEL,
      status: "SEARCHING",
      pickupAddress: { lat: 1, lng: 1 },
      searchMeta: update.$set.searchMeta,
    }));
  });

  it("offers rider A first, then rider B once A has timed out", async () => {
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [],
      searchMeta: { attempt: 0 },
    });
    await offerParcelToNextRider(PARCEL);
    expect(mockParcelFindOneAndUpdate.mock.calls[0][1].$set.searchMeta.offeredTo).toBe(String(RIDER_A));

    // A's offer timed out (offerTimeoutBy now has A); B gets the next round.
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [RIDER_A],
      searchMeta: { attempt: 1, offeredTo: null },
    });
    await offerParcelToNextRider(PARCEL);
    expect(mockParcelFindOneAndUpdate.mock.calls[1][1].$set.searchMeta.offeredTo).toBe(String(RIDER_B));
  });

  it("cycles back to rider A after B also times out — a 2-rider pool never runs dry", async () => {
    // B's offer also timed out. Neither rider explicitly rejected, so both
    // are still eligible, and distance-order cycling brings it back to A.
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [RIDER_A, RIDER_B],
      searchMeta: { attempt: 2, offeredTo: null },
    });
    await offerParcelToNextRider(PARCEL);

    expect(mockParcelFindOneAndUpdate.mock.calls[0][1].$set.searchMeta.offeredTo).toBe(String(RIDER_A));
    // Crucially: no fallback to manual assignment just because both riders
    // already had a turn.
    expect(mockRetractBroadcast).not.toHaveBeenCalledWith(String(PARCEL), null);
  });

  it("falls back to manual assignment only when nobody is eligible at all", async () => {
    mockGetSorted.mockResolvedValue([]);
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [],
      searchMeta: { attempt: 0 },
    });
    await offerParcelToNextRider(PARCEL);

    expect(mockParcelFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PARCEL, status: "SEARCHING" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "REQUESTED" }) }),
    );
  });
});
