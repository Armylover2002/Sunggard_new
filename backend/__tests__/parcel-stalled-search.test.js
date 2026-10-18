import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockParcelFind = jest.fn();
const mockParcelFindOneAndUpdate = jest.fn();
const mockRecordEvent = jest.fn(async () => null);
const mockRefundBookingPayment = jest.fn().mockResolvedValue({ attempted: false });
const mockEmitToAdmins = jest.fn();
const mockEmitToCustomer = jest.fn();
const mockRetractBroadcast = jest.fn().mockResolvedValue({});
const mockCancelParcelSearch = jest.fn();
const mockEmitNotificationEvent = jest.fn();

const chain = (docs) => ({
  select: () => ({ limit: () => ({ lean: async () => docs }) }),
});

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    find: mockParcelFind,
    findOneAndUpdate: mockParcelFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

jest.unstable_mockModule("../app/modules/notifications/notification.constants.js", () => ({
  NOTIFICATION_EVENTS: { PARCEL_STATUS_UPDATE: "PARCEL_STATUS_UPDATE" },
}));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitToAdmins: mockEmitToAdmins,
  emitToCustomer: mockEmitToCustomer,
  retractParcelBroadcast: mockRetractBroadcast,
}));

jest.unstable_mockModule("../app/services/parcelEventService.js", () => ({
  recordParcelEvent: mockRecordEvent,
  PARCEL_EVENT_ACTOR: { CUSTOMER: "customer", DELIVERY: "delivery", ADMIN: "admin", SYSTEM: "system" },
}));

jest.unstable_mockModule("../app/services/porter/porterPaymentService.js", () => ({
  refundBookingPayment: mockRefundBookingPayment,
}));

jest.unstable_mockModule("../app/constants/porterPayment.js", () => ({
  PORTER_BOOKING_KIND: { PARCEL: "parcel" },
  PORTER_PAYMENT_SOURCE: { SYSTEM: "system" },
}));

jest.unstable_mockModule("../app/services/parcelWorkflowService.js", () => ({
  cancelParcelSearch: mockCancelParcelSearch,
}));

const { cancelStalledUnacceptedParcels, STALLED_SEARCH_TIMEOUT_MS } = await import(
  "../app/services/parcelStalledSearchService.js"
);

const PARCEL = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();

const NOW = new Date("2026-10-18T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - STALLED_SEARCH_TIMEOUT_MS - 60_000);
const RECENT = new Date(NOW.getTime() - 60_000);

describe("cancelStalledUnacceptedParcels", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefundBookingPayment.mockResolvedValue({ attempted: false });
    mockParcelFindOneAndUpdate.mockImplementation((filter) => ({
      _id: filter._id,
      status: "CANCELLED",
      customerId: CUSTOMER,
    }));
  });

  it("cancels a SEARCHING booking nobody accepted, past the window", async () => {
    mockParcelFind.mockReturnValue(
      chain([{ _id: PARCEL, status: "SEARCHING", customerId: CUSTOMER, createdAt: OLD }]),
    );

    const result = await cancelStalledUnacceptedParcels(NOW);

    expect(result).toEqual({ checked: 1, cancelled: 1 });
    expect(mockParcelFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: PARCEL, status: { $in: ["SEARCHING", "REQUESTED"] }, deliveryPartnerId: null },
      expect.objectContaining({ $set: { status: "CANCELLED" } }),
      { new: true },
    );
    expect(mockRefundBookingPayment).toHaveBeenCalled();
    expect(mockCancelParcelSearch).toHaveBeenCalledWith(String(PARCEL));
    expect(mockRetractBroadcast).toHaveBeenCalledWith(String(PARCEL), null);
  });

  it("cancels a REQUESTED booking (fell back to manual assignment) past the window too", async () => {
    mockParcelFind.mockReturnValue(
      chain([{ _id: PARCEL, status: "REQUESTED", customerId: CUSTOMER, createdAt: OLD }]),
    );

    const result = await cancelStalledUnacceptedParcels(NOW);

    expect(result).toEqual({ checked: 1, cancelled: 1 });
  });

  it("never queries for a booking a rider has already accepted, regardless of age", async () => {
    // The query itself filters deliveryPartnerId: null — an accepted booking
    // (queued/waiting-list or not) never even reaches the candidate list.
    mockParcelFind.mockReturnValue(chain([]));

    await cancelStalledUnacceptedParcels(NOW);

    expect(mockParcelFind).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ["SEARCHING", "REQUESTED"] },
        deliveryPartnerId: null,
      }),
    );
  });

  it("leaves a booking alone if a rider accepted it between the query and the write (race guard)", async () => {
    mockParcelFind.mockReturnValue(
      chain([{ _id: PARCEL, status: "SEARCHING", customerId: CUSTOMER, createdAt: OLD }]),
    );
    // Simulates the optimistic guard: findOneAndUpdate's filter no longer
    // matches because a rider accepted it in between, so Mongo returns null.
    mockParcelFindOneAndUpdate.mockResolvedValueOnce(null);

    const result = await cancelStalledUnacceptedParcels(NOW);

    expect(result).toEqual({ checked: 1, cancelled: 0 });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("does not cancel a booking still within the window", async () => {
    mockParcelFind.mockReturnValue(
      chain([{ _id: PARCEL, status: "SEARCHING", customerId: CUSTOMER, createdAt: RECENT }]),
    );

    // The service itself only queries with createdAt <= cutoff, so a recent
    // booking is never even returned by the (mocked) query here — this test
    // documents that contract via the query filter it issues.
    await cancelStalledUnacceptedParcels(NOW);

    expect(mockParcelFind).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: { $lte: new Date(NOW.getTime() - STALLED_SEARCH_TIMEOUT_MS) } }),
    );
  });
});
