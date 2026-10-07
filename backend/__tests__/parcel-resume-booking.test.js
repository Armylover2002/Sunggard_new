import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * Retrying a cancelled outstation UPI booking must reuse the row it already
 * created, not duplicate it — the same bug as the local-delivery flow, fixed
 * the same way. See city-parcel-resume-booking.test.js for the local half.
 */

const CUSTOMER = new mongoose.Types.ObjectId().toString();
const PICKUP = {
  name: "Asha Kumari",
  phone: "9876543210",
  fullAddress: "12 Test Street, Connaught Place, Delhi",
  pincode: "110001",
  city: "Delhi",
  lat: 28.6139,
  lng: 77.209,
};
const DROP = { name: "Hub", phone: "9000000001", fullAddress: "Test Hub Road, Delhi" };
const COURIER_ID = new mongoose.Types.ObjectId().toString();

const parcelFindOne = jest.fn();
const parcelCreate = jest.fn();
const parcelFindByIdAndDelete = jest.fn();
const courierFindActiveByNameOrId = jest.fn();
const parcelConfigGetOrCreate = jest.fn();
const parcelCityRateFindRate = jest.fn();
const findNearestParcelSellerWithDistance = jest.fn();
const startParcelBroadcast = jest.fn();
const openBookingPayment = jest.fn();
const emitParcelNewToNearbySellers = jest.fn().mockResolvedValue();

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    findOne: parcelFindOne,
    create: parcelCreate,
    findByIdAndDelete: parcelFindByIdAndDelete,
  },
}));
jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({
  default: { getOrCreate: parcelConfigGetOrCreate },
}));
jest.unstable_mockModule("../app/models/courierCompany.js", () => ({
  default: { findActiveByNameOrId: courierFindActiveByNameOrId },
}));
jest.unstable_mockModule("../app/models/parcelCityRate.js", () => ({
  default: { findRate: parcelCityRateFindRate },
}));
jest.unstable_mockModule("../app/models/delivery.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/models/customer.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/models/admin.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/models/notification.js", () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: jest.fn(),
}));
jest.unstable_mockModule("../app/modules/notifications/notification.constants.js", () => ({
  NOTIFICATION_EVENTS: {},
}));
jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitToAdmins: jest.fn(),
  emitToDelivery: jest.fn(),
  emitToCustomer: jest.fn(),
  retractParcelBroadcast: jest.fn(),
  emitParcelNewToNearbySellers,
  emitToSeller: jest.fn(),
}));
jest.unstable_mockModule("../app/services/parcelWorkflowService.js", () => ({
  startParcelBroadcast,
  parcelAcceptAtomic: jest.fn(),
  parcelRejectAtomic: jest.fn(),
  fetchAvailableParcelsForRider: jest.fn(),
  fetchParcelsForSeller: jest.fn(),
  cancelParcelSearch: jest.fn(),
  computeRiderParcelEarnings: jest.fn(),
  computeRiderParcelEarningBreakdown: jest.fn(() => ({ earning: 0, distanceKm: 0, ratePerKm: 0 })),
}));
jest.unstable_mockModule("../app/services/parcelDataResetService.js", () => ({
  resetAllParcelData: jest.fn(),
}));
jest.unstable_mockModule("../app/services/riderCashService.js", () => ({
  recordCodCollection: jest.fn(),
}));
jest.unstable_mockModule("../app/services/mapsRouteService.js", () => ({
  getCachedRoute: jest.fn(),
}));
jest.unstable_mockModule("../app/services/parcelRazorpayService.js", () => ({
  createParcelCodRemitRazorpayOrder: jest.fn(),
}));
jest.unstable_mockModule("../app/services/porter/porterPaymentService.js", () => ({
  openBookingPayment,
  verifyBookingReceipt: jest.fn(),
  getBookingPaymentHistory: jest.fn(),
  refundBookingPayment: jest.fn().mockResolvedValue({ attempted: false, reason: "NOT_PAID_ONLINE" }),
}));
jest.unstable_mockModule("../app/services/porter/porterDispatchService.js", () => ({
  activatePorterBookingAfterPayment: jest.fn(),
}));
jest.unstable_mockModule("../app/services/porter/customerLedgerService.js", () => ({
  recordPorterCodCollected: jest.fn(),
}));
jest.unstable_mockModule("../app/services/porter/porterWalletPaymentService.js", () => ({
  assertWalletCovers: jest.fn(),
  payBookingFromWallet: jest.fn(),
}));

jest.unstable_mockModule("../app/services/porter/porterRefundService.js", () => ({
  getRefundSummaryByParcel: jest.fn().mockResolvedValue(new Map()),
}));

jest.unstable_mockModule("../app/services/sellerNearbyService.js", () => ({
  findNearestParcelSellerWithDistance,
}));
jest.unstable_mockModule("../app/services/parcelRiderSettlementService.js", () => ({
  applyParcelDeliveredRiderEarning: jest.fn(),
  getSettledParcelEarnings: jest.fn().mockResolvedValue(new Map()),
}));
jest.unstable_mockModule("../app/services/parcelLateRefundService.js", () => ({
  canCustomerRequestLateRefund: jest.fn(),
  creditLateRefundToCustomerWallet: jest.fn(),
  getParcelLatePickupSummary: jest.fn(),
  getParcelPickupDeadline: jest.fn(),
  isNormalParcelPickupLate: jest.fn(),
  NORMAL_PICKUP_SLA_MINUTES: 60,
}));
jest.unstable_mockModule("../app/services/deliveryBusyService.js", () => ({
  syncDeliveryPartnerBusyFlag: jest.fn(),
  deliveryPartnerHasActiveJob: jest.fn().mockResolvedValue(false),
  getDeliveryPartnerActiveJobInfo: jest.fn().mockResolvedValue({ hasActiveJob: false }),
  markDeliveryPartnerBusy: jest.fn(),
}));
// No zones configured — outstation zone gating (createParcel) no-ops, same
// as it did before zones existed at all. Without this mock the real service
// would hit the real (unmocked) DeliveryZone model and hang with no DB.
jest.unstable_mockModule("../app/services/deliveryZoneService.js", () => ({
  isZoneGatingActive: jest.fn().mockResolvedValue(false),
  resolveZoneForPoint: jest.fn().mockResolvedValue(null),
  getActiveZoneById: jest.fn().mockResolvedValue(null),
  isPointInZoneId: jest.fn().mockResolvedValue(false),
}));

const { createParcel } = await import("../app/controller/parcelController.js");

function mockRes() {
  const res = {};
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

const RECEIVER = {
  name: "Rohit Sharma",
  phone: "9123456780",
  fullAddress: "45 Marine Drive, Colaba",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400001",
};

const REQUEST_BODY = {
  pickupAddress: PICKUP,
  dropAddress: DROP,
  receiverAddress: RECEIVER,
  packageDetails: { packageType: "document", weight: 1, description: "papers" },
  courierCompanyId: COURIER_ID,
  destinationCity: "Mumbai",
  pickupWindow: "today",
  deliverySpeed: "normal",
  parcelType: "outstation",
};

const create = (body) => {
  const res = mockRes();
  return createParcel({ body, user: { id: CUSTOMER } }, res).then(() => res);
};

function existingDoc(overrides = {}) {
  return {
    _id: "existing-parcel-id",
    status: "REQUESTED",
    paymentStatus: "PENDING",
    paymentMethod: "UPI",
    razorpayOrderId: "order_dead_1",
    otp: "482913",
    set: jest.fn(),
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  parcelConfigGetOrCreate.mockResolvedValue({
    packageTypes: [{ value: "document", isActive: true }],
    fixedDeliveryCharge: 40,
  });
  courierFindActiveByNameOrId.mockResolvedValue({
    _id: COURIER_ID,
    name: "Test Courier",
    phone: "9000000001",
    isOther: false,
  });
  parcelCityRateFindRate.mockResolvedValue({ charge: 120 });
  openBookingPayment.mockResolvedValue({
    payment: { _id: "pp-1" },
    checkout: {
      orderId: "order_new_1",
      keyId: "rzp_test",
      amount: 15500,
      currency: "INR",
    },
    reused: false,
  });
  startParcelBroadcast.mockResolvedValue({ _id: "cod-1", status: "SEARCHING" });
});

describe("createParcel · resuming a cancelled online payment", () => {
  it("reuses the matching unpaid attempt instead of creating a new row", async () => {
    const existing = existingDoc();
    parcelFindOne.mockReturnValue({ sort: () => Promise.resolve(existing) });

    const res = await create({ ...REQUEST_BODY, paymentMethod: "UPI" });

    expect(parcelCreate).not.toHaveBeenCalled();
    expect(existing.set).toHaveBeenCalledWith(
      expect.objectContaining({ destinationCity: "Mumbai" }),
    );
    expect(existing.save).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body.result.parcel).toBe(existing);
  });

  it("opens a fresh gateway order on the resumed row, clearing the dead one", async () => {
    const existing = existingDoc();
    parcelFindOne.mockReturnValue({ sort: () => Promise.resolve(existing) });

    await create({ ...REQUEST_BODY, paymentMethod: "UPI" });

    expect(existing.razorpayOrderId).toBe("order_new_1");
    expect(openBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing pickup OTP rather than generating a new one", async () => {
    const existing = existingDoc({ otp: "111222" });
    parcelFindOne.mockReturnValue({ sort: () => Promise.resolve(existing) });

    await create({ ...REQUEST_BODY, paymentMethod: "UPI" });

    expect(existing.otp).toBe("111222");
  });

  it("matches on customer, route, courier, destination and parcel type", async () => {
    parcelFindOne.mockReturnValue({ sort: () => Promise.resolve(null) });
    parcelCreate.mockResolvedValue({ _id: "new-1", save: jest.fn() });

    await create({ ...REQUEST_BODY, paymentMethod: "UPI" });

    const query = parcelFindOne.mock.calls[0][0];
    expect(query).toMatchObject({
      customerId: CUSTOMER,
      status: "REQUESTED",
      paymentStatus: "PENDING",
      paymentMethod: "UPI",
      parcelType: "outstation",
      courierCompanyId: COURIER_ID,
      destinationCity: "Mumbai",
      "pickupAddress.lat": PICKUP.lat,
      "pickupAddress.lng": PICKUP.lng,
    });
  });

  it("creates a fresh row and a fresh OTP when no matching attempt exists", async () => {
    parcelFindOne.mockReturnValue({ sort: () => Promise.resolve(null) });
    parcelCreate.mockResolvedValue({ _id: "new-1", save: jest.fn() });

    await create({ ...REQUEST_BODY, paymentMethod: "UPI" });

    expect(parcelCreate).toHaveBeenCalledTimes(1);
    const [args] = parcelCreate.mock.calls[0];
    expect(typeof args.otp).toBe("string");
    expect(args.otp).toHaveLength(4);
  });

  it("never looks for a resumable row on COD, which has no cancel-retry step", async () => {
    parcelCreate.mockResolvedValue({ _id: "cod-1", parcelType: "outstation" });

    await create({ ...REQUEST_BODY, paymentMethod: "COD" });

    expect(parcelFindOne).not.toHaveBeenCalled();
    expect(parcelCreate).toHaveBeenCalledTimes(1);
  });
});
