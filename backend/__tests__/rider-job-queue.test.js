import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * Rider waiting list (accept while on a job) and open bookings (claim any
 * booking in range). The one-job-at-a-time flow is covered by
 * parcel-workflow-busy.test.js with the waiting list switched off.
 */

const mockDeliveryFindById = jest.fn();
const mockParcelFind = jest.fn();
const mockParcelFindById = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockParcelAggregate = jest.fn();
const mockDeliveryUpdate = jest.fn();
const mockEmitOpenChanged = jest.fn();
const mockEmitToCustomer = jest.fn();
const mockNotify = jest.fn();

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: {
    findById: mockDeliveryFindById,
    findByIdAndUpdate: mockDeliveryUpdate,
  },
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    find: mockParcelFind,
    findById: mockParcelFindById,
    findOneAndUpdate: mockParcelFindOneAndUpdate,
    aggregate: mockParcelAggregate,
    exists: jest.fn(),
  },
}));

jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({
  default: {
    getSearchSettings: jest.fn().mockResolvedValue({ deliveryRadiusKm: 5, riderPerKmRate: 10 }),
  },
}));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitParcelBroadcast: jest.fn(),
  retractParcelBroadcast: jest.fn().mockResolvedValue({}),
  retractParcelOfferForRider: jest.fn().mockResolvedValue({}),
  emitToDelivery: jest.fn(),
  emitToCustomer: mockEmitToCustomer,
  emitToAdmins: jest.fn(),
  emitToSeller: jest.fn(),
  emitOpenBookingsChanged: mockEmitOpenChanged,
  emitToOrder: jest.fn(),
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: mockNotify,
}));

jest.unstable_mockModule("../app/services/parcelEventService.js", () => ({
  recordParcelEvent: jest.fn(async () => null),
  PARCEL_EVENT_ACTOR: { CUSTOMER: "customer", DELIVERY: "delivery", ADMIN: "admin", SYSTEM: "system" },
}));

jest.unstable_mockModule("../app/services/porter/riderCashLimitService.js", () => ({
  assertRiderCanTakeJobs: jest.fn(async () => ({ allowed: true })),
  filterRidersWithCashHeadroom: jest.fn(async (ids) => ids),
}));

jest.unstable_mockModule("../app/services/deliveryZoneService.js", () => ({
  getActiveZoneById: jest.fn(async () => null),
  isPointInZoneId: jest.fn(async () => true),
  zoneIdsCoveringPickup: jest.fn(async (zoneId) => new Set(zoneId ? [String(zoneId)] : [])),
}));

jest.unstable_mockModule("../app/config/redis.js", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

const { parcelAcceptAtomic, startQueuedParcel, fetchOpenBookingsForRider, hideQueuedRiderLocation } =
  await import("../app/services/parcelWorkflowService.js");
const { riderCapacity } = await import("../app/services/deliveryBusyService.js");

const chain = (value) => ({
  select: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

const riderId = new mongoose.Types.ObjectId();
const parcelId = new mongoose.Types.ObjectId();

const rider = {
  _id: riderId,
  isParcelService: true,
  isVerified: true,
  isOnline: true,
  location: { coordinates: [77.59, 12.97] },
};

/** Rider's current load: `active` live jobs, `queued` waiting. */
const setLoad = (active, queued) => {
  const rows = [];
  if (active) rows.push({ _id: false, n: active });
  if (queued) rows.push({ _id: true, n: queued });
  mockParcelAggregate.mockResolvedValue(rows);
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RIDER_MAX_QUEUED_JOBS = "2";
  mockDeliveryFindById.mockImplementation(() => chain(rider));
});

describe("riderCapacity", () => {
  test("free rider takes the job live", () => {
    expect(riderCapacity({ activeCount: 0, queuedCount: 0 })).toEqual({ canTake: true, willQueue: false });
  });

  test("busy rider with room queues it", () => {
    expect(riderCapacity({ activeCount: 1, queuedCount: 1 })).toEqual({ canTake: true, willQueue: true });
  });

  test("full waiting list refuses", () => {
    expect(riderCapacity({ activeCount: 1, queuedCount: 2 }).canTake).toBe(false);
  });

  test("waiting list off restores one job at a time", () => {
    process.env.RIDER_MAX_QUEUED_JOBS = "0";
    expect(riderCapacity({ activeCount: 1, queuedCount: 0 })).toMatchObject({
      canTake: false,
      reason: "Finish your current job before taking another.",
    });
  });
});

describe("parcelAcceptAtomic with a waiting list", () => {
  const accepted = (extra) => ({
    _id: parcelId,
    status: "ACCEPTED",
    deliveryPartnerId: { _id: riderId, location: { coordinates: [77.6, 12.9] } },
    customerId: { _id: "cust-1" },
    pickupAddress: { fullAddress: "123 St" },
    ...extra,
  });

  test("a rider on a job accepts into the waiting list; customer sees no location", async () => {
    setLoad(1, 0);
    mockParcelFindById.mockImplementation(() =>
      chain({ _id: parcelId, status: "SEARCHING", pickupAddress: { lat: 12.97, lng: 77.59 } }),
    );
    mockParcelFindOneAndUpdate.mockImplementation(() => chain(accepted({ isQueued: true })));

    const { parcel } = await parcelAcceptAtomic(riderId, parcelId);

    const [filter, update] = mockParcelFindOneAndUpdate.mock.calls[0];
    expect(update.$set.isQueued).toBe(true);
    expect(filter.status).toBe("SEARCHING");
    expect(parcel.isQueued).toBe(true);

    const customerPayload = mockEmitToCustomer.mock.calls[0][1].payload;
    expect(customerPayload.isQueued).toBe(true);
    expect(customerPayload.parcel.deliveryPartnerId.location).toBeUndefined();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bodyKey: "status_accepted_queued" }),
    );
    expect(mockEmitOpenChanged).toHaveBeenCalledWith(String(parcelId), "removed");
  });

  test("a full waiting list refuses the accept", async () => {
    setLoad(1, 2);
    await expect(parcelAcceptAtomic(riderId, parcelId)).rejects.toMatchObject({
      statusCode: 409,
      code: "RIDER_QUEUE_FULL",
    });
    expect(mockParcelFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("open-bookings claim is not limited to the rider's offer turn", async () => {
    setLoad(0, 0);
    mockParcelFindById.mockImplementation(() =>
      chain({ _id: parcelId, status: "SEARCHING", pickupAddress: { lat: 12.97, lng: 77.59 } }),
    );
    mockParcelFindOneAndUpdate.mockImplementation(() => chain(accepted({ isQueued: false })));

    await parcelAcceptAtomic(riderId, parcelId, null, { mode: "open" });

    const [filter, update] = mockParcelFindOneAndUpdate.mock.calls[0];
    expect(update.$set.isQueued).toBe(false);
    expect(filter.deliveryPartnerId).toBeNull();
    expect(JSON.stringify(filter)).not.toContain("offeredTo");
    expect(filter.$or.map((c) => c.status)).toEqual(["SEARCHING", "REQUESTED"]);
  });

  test("a booking someone else already took reports that clearly", async () => {
    setLoad(0, 0);
    mockParcelFindById.mockImplementation(() =>
      chain({
        _id: parcelId,
        status: "ACCEPTED",
        deliveryPartnerId: new mongoose.Types.ObjectId(),
        pickupAddress: { lat: 12.97, lng: 77.59 },
      }),
    );
    mockParcelFindOneAndUpdate.mockImplementation(() => chain(null));

    await expect(parcelAcceptAtomic(riderId, parcelId, null, { mode: "open" })).rejects.toMatchObject({
      statusCode: 409,
      message: "Another rider already accepted this booking.",
    });
  });
});

describe("startQueuedParcel", () => {
  test("refused while another delivery is live", async () => {
    mockParcelFindById.mockImplementation(() =>
      chain({ _id: parcelId, deliveryPartnerId: riderId, status: "ACCEPTED", isQueued: true }),
    );
    setLoad(1, 1);
    await expect(startQueuedParcel(riderId, parcelId)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACTIVE_JOB_IN_PROGRESS",
    });
    expect(mockParcelFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("starts the job and re-snapshots the payout start point", async () => {
    mockParcelFindById.mockImplementation(() =>
      chain({ _id: parcelId, deliveryPartnerId: riderId, status: "ACCEPTED", isQueued: true }),
    );
    setLoad(0, 1);
    const started = {
      _id: parcelId,
      status: "ACCEPTED",
      isQueued: false,
      otp: "1234",
      customerId: { _id: "cust-1" },
      toObject() {
        const { toObject, ...rest } = this;
        return { ...rest };
      },
    };
    mockParcelFindOneAndUpdate.mockImplementation(() => chain(started));

    const { parcel } = await startQueuedParcel(riderId, parcelId);

    const [filter, update] = mockParcelFindOneAndUpdate.mock.calls[0];
    expect(filter.isQueued).toBe(true);
    expect(update.$set.isQueued).toBe(false);
    expect(update.$set.riderAcceptLocation).toEqual({ lat: 12.97, lng: 77.59 });
    expect(parcel.otp).toBeUndefined();
    expect(mockEmitToCustomer.mock.calls[0][1].payload.isQueued).toBe(false);
  });

  test("someone else's parcel is not found", async () => {
    mockParcelFindById.mockImplementation(() =>
      chain({ _id: parcelId, deliveryPartnerId: new mongoose.Types.ObjectId(), isQueued: true }),
    );
    await expect(startQueuedParcel(riderId, parcelId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("fetchOpenBookingsForRider", () => {
  test("lists bookings in radius, nearest first, and drops ones out of range", async () => {
    setLoad(0, 0);
    const near = { _id: "a", pickupAddress: { lat: 12.971, lng: 77.591 }, createdAt: 2 };
    const nearer = { _id: "b", pickupAddress: { lat: 12.9701, lng: 77.5901 }, createdAt: 1 };
    const far = { _id: "c", pickupAddress: { lat: 13.5, lng: 78.2 }, createdAt: 3 };
    mockParcelFind.mockImplementation(() => chain([near, nearer, far]));

    const result = await fetchOpenBookingsForRider(riderId);

    expect(result.canAccept).toBe(true);
    expect(result.willQueue).toBe(false);
    expect(result.bookings.map((b) => b._id)).toEqual(["b", "a"]);
    expect(result.bookings[0].estimatedEarning).toBeGreaterThanOrEqual(0);
  });

  test("a rider with a full waiting list still sees the list but cannot accept", async () => {
    setLoad(1, 2);
    mockParcelFind.mockImplementation(() =>
      chain([{ _id: "a", pickupAddress: { lat: 12.971, lng: 77.591 } }]),
    );
    const result = await fetchOpenBookingsForRider(riderId);
    expect(result.bookings).toHaveLength(1);
    expect(result.canAccept).toBe(false);
    expect(result.blockedReason).toMatch(/waiting list is full/);
  });

  test("offline rider gets an explanation, not a list", async () => {
    mockDeliveryFindById.mockImplementation(() => chain({ ...rider, isOnline: false }));
    const result = await fetchOpenBookingsForRider(riderId);
    expect(result.bookings).toEqual([]);
    expect(result.blockedReason).toMatch(/online/i);
  });
});

test("hideQueuedRiderLocation leaves started jobs alone", () => {
  const live = { isQueued: false, deliveryPartnerId: { location: { coordinates: [1, 2] } } };
  expect(hideQueuedRiderLocation(live).deliveryPartnerId.location).toBeDefined();
});
