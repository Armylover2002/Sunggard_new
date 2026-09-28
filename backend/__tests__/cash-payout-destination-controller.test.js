import { jest } from "@jest/globals";

/**
 * The controller wiring for the deposit-destination endpoints: a rider gets
 * a read-only view, only an admin can write, and a validation failure from
 * the service reaches the client as the 400 it threw, not a generic 500.
 */

const getCashPayoutDestination = jest.fn();
const updateCashPayoutDestination = jest.fn();

jest.unstable_mockModule("../app/models/parcel.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/services/riderCashService.js", () => ({
  getRiderCodSummary: jest.fn(),
  createCashDeposit: jest.fn(),
  reviewCashDeposit: jest.fn(),
  listCashDeposits: jest.fn(),
  getFleetCashHoldings: jest.fn(),
  getCashPayoutDestination,
  updateCashPayoutDestination,
}));
jest.unstable_mockModule("../app/services/codQrService.js", () => ({
  createCodQr: jest.fn(),
  fetchCodQrStatus: jest.fn(),
  closeCodQr: jest.fn(),
  isCodQrAvailable: jest.fn(),
}));

const {
  riderGetCashPayoutDestination,
  adminGetCashPayoutDestination,
  adminUpdateCashPayoutDestination,
} = await import("../app/controller/riderCashController.js");

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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("riderGetCashPayoutDestination", () => {
  it("returns the configured destination to the rider", async () => {
    getCashPayoutDestination.mockResolvedValue({ upiId: "admin@okhdfc" });
    const res = mockRes();

    await riderGetCashPayoutDestination({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.result.upiId).toBe("admin@okhdfc");
  });
});

describe("adminGetCashPayoutDestination", () => {
  it("returns the same data for the admin panel to prefill", async () => {
    getCashPayoutDestination.mockResolvedValue({ upiId: "admin@okhdfc" });
    const res = mockRes();

    await adminGetCashPayoutDestination({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.result.upiId).toBe("admin@okhdfc");
  });
});

describe("adminUpdateCashPayoutDestination", () => {
  it("passes the body through to the service and returns 200", async () => {
    updateCashPayoutDestination.mockResolvedValue({ upiId: "new@bank" });
    const res = mockRes();

    await adminUpdateCashPayoutDestination({ body: { upiId: "new@bank" } }, res);

    expect(updateCashPayoutDestination).toHaveBeenCalledWith({ upiId: "new@bank" });
    expect(res.statusCode).toBe(200);
    expect(res.body.result.upiId).toBe("new@bank");
  });

  it("surfaces a service validation error with its own status code", async () => {
    const err = new Error("Enter a valid UPI ID (e.g. admin@bank)");
    err.statusCode = 400;
    updateCashPayoutDestination.mockRejectedValue(err);
    const res = mockRes();

    await adminUpdateCashPayoutDestination({ body: { upiId: "garbage" } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/valid UPI/);
  });

  it("tolerates a missing body", async () => {
    updateCashPayoutDestination.mockResolvedValue({});
    const res = mockRes();

    await adminUpdateCashPayoutDestination({}, res);

    expect(updateCashPayoutDestination).toHaveBeenCalledWith({});
    expect(res.statusCode).toBe(200);
  });
});
