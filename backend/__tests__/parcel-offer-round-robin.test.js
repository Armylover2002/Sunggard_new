import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockParcelFindById = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockParcelFind = jest.fn();
const mockParcelUpdateOne = jest.fn().mockResolvedValue({});
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
    updateOne: mockParcelUpdateOne,
    find: mockParcelFind,
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

const { offerParcelToNextRider, sweepExpiredParcelOffers } = await import(
  "../app/services/parcelWorkflowService.js"
);

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
      searchMeta: { attempt: 1, offeredTo: null, lastOfferedTo: RIDER_A },
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
      searchMeta: { attempt: 2, offeredTo: null, lastOfferedTo: RIDER_B },
    });
    await offerParcelToNextRider(PARCEL);

    expect(mockParcelFindOneAndUpdate.mock.calls[0][1].$set.searchMeta.offeredTo).toBe(String(RIDER_A));
    // Crucially: no fallback to manual assignment just because both riders
    // already had a turn.
    expect(mockRetractBroadcast).not.toHaveBeenCalledWith(String(PARCEL), null);
  });

  it("never re-offers to whoever just timed out, even if the eligible pool's size changed since (the reported bug)", async () => {
    // Round 1: A, B and C are all eligible; A gets the offer.
    mockGetSorted.mockResolvedValueOnce([
      { id: String(RIDER_A), distanceM: 100 },
      { id: String(RIDER_B), distanceM: 200 },
      { id: "c3c3c3c3c3c3c3c3c3c3c3c3", distanceM: 300 },
    ]);
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

    // Round 2: A timed out (lastOfferedTo: A, as processParcelSearchTimeout
    // would set), but C has since gone offline — the pool shrank from 3 to 2
    // between rounds. The old attempt-modulo selection could land back on A
    // here; the fix must not.
    mockGetSorted.mockResolvedValueOnce([
      { id: String(RIDER_A), distanceM: 100 },
      { id: String(RIDER_B), distanceM: 200 },
    ]);
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [RIDER_A],
      searchMeta: { attempt: 1, offeredTo: null, lastOfferedTo: RIDER_A },
    });
    await offerParcelToNextRider(PARCEL);
    expect(mockParcelFindOneAndUpdate.mock.calls[1][1].$set.searchMeta.offeredTo).toBe(String(RIDER_B));
  });

  it("includes the attempt counter as an optimistic-concurrency guard, so two concurrent calls can't both win", async () => {
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      skippedBy: [],
      offerTimeoutBy: [],
      searchMeta: { attempt: 3 },
    });
    await offerParcelToNextRider(PARCEL);

    const filter = mockParcelFindOneAndUpdate.mock.calls[0][0];
    expect(filter["searchMeta.attempt"]).toBe(3);

    // The second of two near-simultaneous calls reads the same "attempt: 3"
    // state (the first hasn't written yet) and must also filter on 3 — so
    // once the first writer's update lands, the second's matching filter no
    // longer applies and MongoDB legitimately returns null for it. Confirm
    // the code treats that null as "someone else already handled this" and
    // sends no broadcast of its own.
    mockEmitParcelBroadcast.mockClear();
    mockParcelFindOneAndUpdate.mockReturnValueOnce(null);
    await offerParcelToNextRider(PARCEL);
    expect(mockEmitParcelBroadcast).not.toHaveBeenCalled();
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

describe("sweepExpiredParcelOffers recovers a search whose in-memory timer was lost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSorted.mockResolvedValue([{ id: String(RIDER_A), distanceM: 100 }]);
  });

  const findChain = (docs) => ({
    select: () => ({ limit: () => ({ lean: async () => docs }) }),
  });

  it("finds every SEARCHING parcel past its offer window and advances each one", async () => {
    mockParcelFind.mockReturnValue(findChain([{ _id: PARCEL }]));
    // processParcelSearchTimeout's own re-read: window has genuinely passed
    // and nobody currently holds the offer, so it moves straight to picking
    // a next rider — same as the in-memory timer would have done.
    mockParcelFindById.mockResolvedValue({
      _id: PARCEL,
      status: "SEARCHING",
      deliveryPartnerId: null,
      pickupAddress: { lat: 1, lng: 1 },
      searchExpiresAt: new Date(Date.now() - 1000),
      skippedBy: [],
      offerTimeoutBy: [],
      searchMeta: { attempt: 0 },
    });

    const result = await sweepExpiredParcelOffers();

    expect(mockParcelFind).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SEARCHING", deliveryPartnerId: null }),
    );
    expect(result).toEqual({ found: 1, processed: 1 });
    expect(mockEmitParcelBroadcast).toHaveBeenCalled();
  });

  it("finds nothing to do when no search has actually expired", async () => {
    mockParcelFind.mockReturnValue(findChain([]));
    const result = await sweepExpiredParcelOffers();
    expect(result).toEqual({ found: 0, processed: 0 });
  });

  it("one parcel failing doesn't stop the rest of the sweep", async () => {
    const OTHER = new mongoose.Types.ObjectId();
    mockParcelFind.mockReturnValue(findChain([{ _id: PARCEL }, { _id: OTHER }]));
    // First lookup throws; second succeeds normally.
    mockParcelFindById
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        _id: OTHER,
        status: "SEARCHING",
        deliveryPartnerId: null,
        pickupAddress: { lat: 1, lng: 1 },
        searchExpiresAt: new Date(Date.now() - 1000),
        skippedBy: [],
        offerTimeoutBy: [],
        searchMeta: { attempt: 0 },
      });

    const result = await sweepExpiredParcelOffers();
    expect(result).toEqual({ found: 2, processed: 1 });
  });
});
