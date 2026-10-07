import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockDeliveryFind = jest.fn();
const mockNotificationInsertMany = jest.fn().mockResolvedValue([]);
const mockGetParcelRiderIdsNearPickup = jest.fn(async () => []);
const mockEmitNotificationEvent = jest.fn();
const mockFilterCashHeadroom = jest.fn(async (ids) => ids);

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: {
    find: mockDeliveryFind,
  },
}));

jest.unstable_mockModule("../app/models/notification.js", () => ({
  default: {
    insertMany: mockNotificationInsertMany,
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
    deleteMany: jest.fn().mockResolvedValue({}),
  },
}));

jest.unstable_mockModule("../app/services/deliveryNearbyService.js", () => ({
  getParcelRiderIdsNearPickup: mockGetParcelRiderIdsNearPickup,
}));

jest.unstable_mockModule("../app/services/sellerNearbyService.js", () => ({
  getParcelSellerIdsNearPickup: jest.fn(async () => []),
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

jest.unstable_mockModule("../app/services/porter/riderCashLimitService.js", () => ({
  filterRidersWithCashHeadroom: mockFilterCashHeadroom,
}));

const { emitParcelBroadcast } = await import("../app/services/orderSocketEmitter.js");

const RIDER_A = new mongoose.Types.ObjectId();
const PARCEL = new mongoose.Types.ObjectId();

describe("a rider re-offered the same parcel on a later round still gets a push", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeliveryFind.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: RIDER_A, language: "en" }] }),
    });
  });

  it("sets a per-round dedupe status so the key differs from the rider's earlier offer", async () => {
    // Round 1: rider A's first offer for this parcel.
    await emitParcelBroadcast(1, 1, 5, {
      parcelId: String(PARCEL),
      searchExpiresAt: new Date("2026-10-07T10:00:00.000Z"),
    }, { riderIds: [String(RIDER_A)] });

    const firstCall = mockEmitNotificationEvent.mock.calls[0];
    expect(firstCall[0]).toBe("NEW_PARCEL_BROADCAST");
    const firstStatus = firstCall[1].status;
    expect(firstStatus).toBeTruthy();

    // Round 2: the cycle wrapped back to rider A (see offerParcelToNextRider) —
    // a genuinely new offer with its own fresh deadline.
    mockEmitNotificationEvent.mockClear();
    await emitParcelBroadcast(1, 1, 5, {
      parcelId: String(PARCEL),
      searchExpiresAt: new Date("2026-10-07T10:05:00.000Z"),
    }, { riderIds: [String(RIDER_A)] });

    const secondCall = mockEmitNotificationEvent.mock.calls[0];
    const secondStatus = secondCall[1].status;

    // The actual regression this guards: before the fix, status was always
    // undefined here, so both rounds produced the identical dedupe key —
    // <event>:<role>:<riderId>:<parcelId>:"" — and the 24h-TTL dedupe in
    // notify() silently dropped every round after the rider's very first
    // offer for this parcel. No push on round 2 means no native overlay on
    // the rider's phone, even though the server really did make the offer.
    expect(secondStatus).toBeTruthy();
    expect(secondStatus).not.toBe(firstStatus);
  });
});
