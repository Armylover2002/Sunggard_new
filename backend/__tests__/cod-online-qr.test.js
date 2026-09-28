import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * A COD customer paying by UPI at the doorstep instead of handing over cash.
 *
 * The point of these is that the booking must stop being COD when the QR is
 * paid: the money went to the platform's Razorpay account, so the rider is
 * carrying nothing for it and it must never surface in the cash-deposit
 * pipeline. The rest guards against charging the customer twice.
 */

const RIDER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_RIDER_ID = new mongoose.Types.ObjectId().toString();
const BOOKING_ID = new mongoose.Types.ObjectId().toString();

const parcelFindById = jest.fn();
const createCodQr = jest.fn();
const fetchCodQrStatus = jest.fn();
const closeCodQr = jest.fn().mockResolvedValue(null);
const isCodQrAvailable = jest.fn().mockReturnValue(true);

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: { findById: parcelFindById },
}));
jest.unstable_mockModule("../app/services/codQrService.js", () => ({
  createCodQr,
  fetchCodQrStatus,
  closeCodQr,
  isCodQrAvailable,
}));
jest.unstable_mockModule("../app/services/riderCashService.js", () => ({
  getRiderCodSummary: jest.fn(),
  createCashDeposit: jest.fn(),
  reviewCashDeposit: jest.fn(),
  listCashDeposits: jest.fn(),
  getFleetCashHoldings: jest.fn(),
  getCashPayoutDestination: jest.fn(),
  updateCashPayoutDestination: jest.fn(),
}));

const { riderCreateCodQr, riderCheckCodQr } = await import(
  "../app/controller/riderCashController.js"
);

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

/** A COD outstation-parcel document as the controller mutates it. */
const parcelBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  deliveryPartnerId: RIDER_ID,
  paymentMethod: "COD",
  paymentStatus: "PENDING",
  // Pre-pickup: the QR flow is only offered before the rider has physically
  // collected the cash — see PRE_PICKUP_STATUSES in the controller.
  status: "ACCEPTED",
  fare: 300,
  codSettlement: { collectAmount: 300, status: "COLLECT_PENDING" },
  codOnlineQr: {},
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  isCodQrAvailable.mockReturnValue(true);
  closeCodQr.mockResolvedValue(null);
});

describe("riderCreateCodQr", () => {
  it("mints a fixed-amount QR for the booking's COD amount", async () => {
    const booking = parcelBooking();
    parcelFindById.mockResolvedValue(booking);
    createCodQr.mockResolvedValue({
      qrId: "qr_1",
      imageUrl: "https://rzp/qr_1.png",
      amount: 30000,
      closeBy: new Date(),
    });

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(createCodQr).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300 }),
    );
    expect(booking.codOnlineQr.qrId).toBe("qr_1");
    expect(booking.save).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });

  it("reuses a live QR instead of minting a second way to charge the same booking", async () => {
    const booking = parcelBooking({
      codOnlineQr: { qrId: "qr_existing", imageUrl: "u", amount: 30000, paidAt: null },
    });
    parcelFindById.mockResolvedValue(booking);

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(createCodQr).not.toHaveBeenCalled();
    expect(res.body.result.qrId).toBe("qr_existing");
  });

  it("refuses a booking assigned to someone else", async () => {
    parcelFindById.mockResolvedValue(parcelBooking({ deliveryPartnerId: OTHER_RIDER_ID }));

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(createCodQr).not.toHaveBeenCalled();
  });

  it("refuses a booking that is already paid", async () => {
    parcelFindById.mockResolvedValue(parcelBooking({ paymentStatus: "PAID" }));

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(createCodQr).not.toHaveBeenCalled();
  });

  it("refuses once the parcel has already been picked up", async () => {
    parcelFindById.mockResolvedValue(parcelBooking({ status: "PICKED_UP" }));

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(createCodQr).not.toHaveBeenCalled();
  });

  it("tells the rider to collect cash when Razorpay is not configured", async () => {
    isCodQrAvailable.mockReturnValue(false);

    const res = mockRes();
    await riderCreateCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(parcelFindById).not.toHaveBeenCalled();
  });
});

describe("riderCheckCodQr", () => {
  it("converts a paid outstation parcel out of COD entirely", async () => {
    const parcel = parcelBooking({
      codOnlineQr: { qrId: "qr_2", amount: 30000 },
      codSettlement: { collectAmount: 300, status: "RIDER_HOLDING" },
    });
    parcelFindById.mockResolvedValue(parcel);
    fetchCodQrStatus.mockResolvedValue({ paid: true, paymentId: "pay_2" });

    const res = mockRes();
    await riderCheckCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(parcel.paymentStatus).toBe("PAID");
    expect(parcel.paymentMethod).toBe("UPI");
    // Zeroed and NOT_APPLICABLE, so this can never appear as cash the rider
    // is holding or owes a deposit for.
    expect(parcel.codSettlement.collectAmount).toBe(0);
    expect(parcel.codSettlement.status).toBe("NOT_APPLICABLE");
    expect(parcel.save).toHaveBeenCalled();
    expect(closeCodQr).toHaveBeenCalledWith("qr_2");
    expect(res.body.result.paid).toBe(true);
  });

  it("reports still-waiting without touching the booking", async () => {
    const booking = parcelBooking({ codOnlineQr: { qrId: "qr_1", amount: 30000 } });
    parcelFindById.mockResolvedValue(booking);
    fetchCodQrStatus.mockResolvedValue({ paid: false, amountReceived: 0 });

    const res = mockRes();
    await riderCheckCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.body.result.paid).toBe(false);
    expect(booking.save).not.toHaveBeenCalled();
    expect(booking.paymentStatus).toBe("PENDING");
  });

  it("answers from the document once converted, without calling Razorpay again", async () => {
    const booking = parcelBooking({
      paymentStatus: "PAID",
      paymentMethod: "UPI",
      codOnlineQr: { qrId: "qr_1", paidAt: new Date() },
    });
    parcelFindById.mockResolvedValue(booking);

    const res = mockRes();
    await riderCheckCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(fetchCodQrStatus).not.toHaveBeenCalled();
    expect(res.body.result.paid).toBe(true);
  });

  it("closes a stale QR and refuses once the rider has already picked up for cash", async () => {
    const booking = parcelBooking({
      status: "PICKED_UP",
      codOnlineQr: { qrId: "qr_1", amount: 30000 },
    });
    parcelFindById.mockResolvedValue(booking);

    const res = mockRes();
    await riderCheckCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(closeCodQr).toHaveBeenCalledWith("qr_1");
    expect(fetchCodQrStatus).not.toHaveBeenCalled();
    expect(booking.paymentStatus).toBe("PENDING");
  });

  it("refuses to poll a booking with no QR", async () => {
    parcelFindById.mockResolvedValue(parcelBooking({ codOnlineQr: {} }));

    const res = mockRes();
    await riderCheckCodQr(
      { params: { kind: "parcel", id: BOOKING_ID }, user: { id: RIDER_ID } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(fetchCodQrStatus).not.toHaveBeenCalled();
  });
});
