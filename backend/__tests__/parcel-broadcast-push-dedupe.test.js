import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockDeliveryFind = jest.fn();
const mockNotificationInsertMany = jest.fn().mockResolvedValue([]);
const mockNotificationBulkWrite = jest.fn().mockResolvedValue({});
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
    bulkWrite: mockNotificationBulkWrite,
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

describe("one in-app row per rider per courier, and the push shows the order amount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeliveryFind.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: RIDER_A, language: "en" }] }),
    });
  });

  const offer = (searchExpiresAt, preview = {}) => ({
    parcelId: String(PARCEL),
    searchExpiresAt: new Date(searchExpiresAt),
    preview: { fare: 318, earnings: 0, paymentMethod: "COD", collectAmount: 318, ...preview },
  });

  it("refreshes the same row every round instead of adding another", async () => {
    await emitParcelBroadcast(1, 1, 5, offer("2026-10-07T10:00:00.000Z"), { riderIds: [String(RIDER_A)] });
    await emitParcelBroadcast(1, 1, 5, offer("2026-10-07T10:05:00.000Z"), { riderIds: [String(RIDER_A)] });

    expect(mockNotificationInsertMany).not.toHaveBeenCalled();
    const [first, second] = mockNotificationBulkWrite.mock.calls.map(([ops]) => ops[0].updateOne);
    // both rounds target the identical row, and both upsert it
    expect(second.filter).toEqual(first.filter);
    expect(first.filter).toMatchObject({ type: "parcel", "data.parcelId": String(PARCEL) });
    expect(first.upsert).toBe(true);
  });

  it("tells notify() to replace the earlier round's list entry", async () => {
    await emitParcelBroadcast(1, 1, 5, offer("2026-10-07T10:00:00.000Z"), { riderIds: [String(RIDER_A)] });
    expect(mockEmitNotificationEvent.mock.calls[0][1].replacePrevious).toBe(true);
  });

  it("puts the amount the rider collects on the push, not the rider's 0 payout", async () => {
    await emitParcelBroadcast(1, 1, 5, offer("2026-10-07T10:00:00.000Z"), { riderIds: [String(RIDER_A)] });
    const data = mockEmitNotificationEvent.mock.calls[0][1].data;
    expect(data.total).toBe(318);
    expect(data.amount).toBe(318);
    expect(data.collectAmount).toBe(318);
    // pre-accept the real payout is 0 — showing it was the "₹0" bug
    expect(data.earnings).toBe(318);
  });

  it("falls back to the booking total for a prepaid booking", async () => {
    await emitParcelBroadcast(
      1, 1, 5,
      offer("2026-10-07T10:00:00.000Z", { paymentMethod: "UPI", collectAmount: 0, total: 300 }),
      { riderIds: [String(RIDER_A)] },
    );
    const data = mockEmitNotificationEvent.mock.calls[0][1].data;
    expect(data.total).toBe(300);
    expect(data.amount).toBe(300);
  });

  it("keeps the rider's real earnings once there are some", async () => {
    await emitParcelBroadcast(
      1, 1, 5,
      offer("2026-10-07T10:00:00.000Z", { earnings: 42 }),
      { riderIds: [String(RIDER_A)] },
    );
    expect(mockEmitNotificationEvent.mock.calls[0][1].data.earnings).toBe(42);
  });
});
