import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockDeliveryFindById = jest.fn();
const mockParcelFind = jest.fn();
const mockParcelFindById = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockGetSearchSettings = jest.fn().mockResolvedValue({ baseSearchRadiusKm: 5 });
const mockHasActiveJob = jest.fn();
const mockMarkBusy = jest.fn();

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: {
    findById: mockDeliveryFindById,
  },
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    find: mockParcelFind,
    findById: mockParcelFindById,
    findOneAndUpdate: mockParcelFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({
  default: {
    getSearchSettings: mockGetSearchSettings,
  },
}));

jest.unstable_mockModule("../app/services/deliveryBusyService.js", () => ({
  deliveryPartnerHasActiveJob: mockHasActiveJob,
  markDeliveryPartnerBusy: mockMarkBusy,
  syncDeliveryPartnerBusyFlag: jest.fn(),
}));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitParcelBroadcast: jest.fn(),
  retractParcelBroadcast: jest.fn().mockResolvedValue({}),
  retractParcelOfferForRider: jest.fn().mockResolvedValue({}),
  emitToDelivery: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToSeller: jest.fn(),
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: jest.fn(),
}));

/**
 * Every status change now appends a row to the parcel's timeline. That write
 * goes to a real mongoose model, which — with no connection open under a unit
 * test — buffers instead of failing, so an accept or a status update hung
 * until the test timed out. The trail itself is covered elsewhere; here it
 * only has to not block the transition being tested.
 */
jest.unstable_mockModule("../app/services/parcelEventService.js", () => ({
  recordParcelEvent: jest.fn(async () => null),
  PARCEL_EVENT_ACTOR: {
    CUSTOMER: "customer",
    DELIVERY: "delivery",
    ADMIN: "admin",
    SYSTEM: "system",
  },
}));

jest.unstable_mockModule("../app/config/redis.js", () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
}));

const {
  fetchAvailableParcelsForRider,
  parcelAcceptAtomic,
} = await import("../app/services/parcelWorkflowService.js");

describe("parcelWorkflowService busy locking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("fetchAvailableParcelsForRider returns empty array when rider has an active job", async () => {
    const riderId = new mongoose.Types.ObjectId();
    mockDeliveryFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: riderId,
        isParcelService: true,
        isVerified: true,
        isOnline: true,
        location: { coordinates: [77.59, 12.97] },
      }),
    });

    mockHasActiveJob.mockResolvedValue(true);

    const available = await fetchAvailableParcelsForRider(riderId);

    expect(mockHasActiveJob).toHaveBeenCalledWith(riderId);
    expect(available).toEqual([]);
    expect(mockParcelFind).not.toHaveBeenCalled();
  });

  test("parcelAcceptAtomic rejects with 409 when rider has an active job", async () => {
    const riderId = new mongoose.Types.ObjectId();
    const parcelId = new mongoose.Types.ObjectId();

    mockDeliveryFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: riderId,
        isParcelService: true,
        isVerified: true,
        name: "Rider One",
        phone: "9876543210",
      }),
    });

    mockHasActiveJob.mockResolvedValue(true);

    await expect(parcelAcceptAtomic(riderId, parcelId)).rejects.toMatchObject({
      statusCode: 409,
      message: "Finish your current job before taking another.",
    });

    expect(mockHasActiveJob).toHaveBeenCalledWith(riderId);
    expect(mockMarkBusy).not.toHaveBeenCalled();
    expect(mockParcelFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("parcelAcceptAtomic claims parcel and marks delivery partner busy when rider is free", async () => {
    const riderId = new mongoose.Types.ObjectId();
    const parcelId = new mongoose.Types.ObjectId();

    mockDeliveryFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: riderId,
        isParcelService: true,
        isVerified: true,
        name: "Rider One",
        phone: "9876543210",
        location: { coordinates: [77.59, 12.97] },
      }),
    });

    mockParcelFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: parcelId,
        pickupAddress: { lat: 12.97, lng: 77.59 },
      }),
    });

    const updatedParcel = {
      _id: parcelId,
      status: "ACCEPTED",
      deliveryPartnerId: riderId,
      customerId: { _id: "cust-1", name: "Customer", phone: "123" },
      pickupAddress: { fullAddress: "123 St" },
    };

    const populateChain = {
      populate: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve(updatedParcel)),
      catch: jest.fn(),
    };
    mockParcelFindOneAndUpdate.mockReturnValue(populateChain);

    mockHasActiveJob.mockResolvedValue(false);

    const result = await parcelAcceptAtomic(riderId, parcelId);

    expect(mockHasActiveJob).toHaveBeenCalledWith(riderId);
    expect(mockMarkBusy).toHaveBeenCalledWith(riderId);
    expect(result.duplicate).toBe(false);
  });
});
