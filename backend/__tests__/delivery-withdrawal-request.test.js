import { jest } from "@jest/globals";
import mongoose from "mongoose";

/**
 * A rider asking to be paid their earnings.
 *
 * The rules here exist because the previous version had none: it accepted any
 * amount above zero, summed EVERY settled transaction as "balance" (including
 * cash-settlement debits, so the number disagreed with the rider's own
 * earnings screen), allowed unlimited concurrent requests against one
 * balance, and recorded no destination — leaving the admin to approve a
 * payment with nowhere to send it.
 */

const RIDER_ID = new mongoose.Types.ObjectId().toString();

const deliveryFindById = jest.fn();
const transactionFind = jest.fn();
const transactionCreate = jest.fn();

const chain = (result) => ({
  select: () => ({ lean: () => Promise.resolve(result) }),
  lean: () => Promise.resolve(result),
});

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: deliveryFindById },
}));
jest.unstable_mockModule("../app/models/transaction.js", () => ({
  default: { find: transactionFind, create: transactionCreate },
}));
jest.unstable_mockModule("../app/models/parcel.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/models/parcelConfig.js", () => ({ default: {} }));
jest.unstable_mockModule("../app/services/firebaseService.js", () => ({
  writeDeliveryLocation: jest.fn(),
  appendTrailPoint: jest.fn(),
  clearOrderTracking: jest.fn(),
  clearRiderPresence: jest.fn(),
}));
jest.unstable_mockModule("../app/services/delivery/deliveryEarningsService.js", () => ({
  getDeliveryStats: jest.fn(),
  getDeliveryEarnings: jest.fn(),
  getDeliveryCodCashSummary: jest.fn(),
}));
jest.unstable_mockModule("../app/services/parcelWorkflowService.js", () => ({
  computeRiderParcelEarnings: jest.fn(),
}));
jest.unstable_mockModule("../app/services/delivery/locationThrottleService.js", () => ({
  shouldThrottle: jest.fn().mockReturnValue(false),
}));

const { requestWithdrawal } = await import("../app/controller/deliveryController.js");

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

const FULL_BANK = {
  _id: RIDER_ID,
  name: "Asha",
  phone: "9990001111",
  accountHolder: "ASHA KUMARI",
  accountNumber: "123456789012",
  ifsc: "HDFC0001234",
  bankName: "HDFC Bank",
  upiId: "",
  qrImageUrl: "",
};

/** ₹2,000 earned, nothing withdrawn. */
const EARNINGS_ONLY = [
  { type: "Delivery Earning", status: "Settled", amount: 1500 },
  { type: "Incentive", status: "Settled", amount: 500 },
];

const call = (body) => {
  const res = mockRes();
  return requestWithdrawal({ body, user: { id: RIDER_ID } }, res).then(() => res);
};

beforeEach(() => {
  jest.clearAllMocks();
  transactionCreate.mockImplementation(async (doc) => doc);
});

describe("requestWithdrawal", () => {
  it("creates a pending request and snapshots where to pay it", async () => {
    deliveryFindById.mockReturnValue(chain(FULL_BANK));
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    const res = await call({ amount: 1200 });

    expect(res.statusCode).toBe(201);
    const created = transactionCreate.mock.calls[0][0];
    expect(created.type).toBe("Withdrawal");
    expect(created.status).toBe("Pending");
    expect(created.amount).toBe(-1200);
    expect(created.meta.payout).toMatchObject({
      accountNumber: "123456789012",
      ifsc: "HDFC0001234",
      bankName: "HDFC Bank",
    });
    expect(created.meta.requestedBalance).toBe(2000);
  });

  describe("choosing bank or UPI", () => {
    const BOTH = { ...FULL_BANK, upiId: "asha@okhdfc", qrImageUrl: "" };

    beforeEach(() => {
      transactionFind.mockReturnValue(chain(EARNINGS_ONLY));
    });

    it("sends only the bank details when the rider picks bank", async () => {
      deliveryFindById.mockReturnValue(chain(BOTH));
      const res = await call({ amount: 500, method: "bank" });

      expect(res.statusCode).toBe(201);
      const payout = transactionCreate.mock.calls[0][0].meta.payout;
      expect(payout).toMatchObject({ method: "bank", accountNumber: "123456789012", ifsc: "HDFC0001234" });
      expect(payout.upiId).toBeUndefined();
      expect(payout.qrImageUrl).toBeUndefined();
    });

    it("sends only the UPI details when the rider picks UPI", async () => {
      deliveryFindById.mockReturnValue(chain(BOTH));
      const res = await call({ amount: 500, method: "upi" });

      expect(res.statusCode).toBe(201);
      const payout = transactionCreate.mock.calls[0][0].meta.payout;
      expect(payout).toMatchObject({ method: "upi", upiId: "asha@okhdfc" });
      expect(payout.accountNumber).toBeUndefined();
      expect(payout.ifsc).toBeUndefined();
    });

    it("asks the rider to choose when both are saved and none was picked", async () => {
      deliveryFindById.mockReturnValue(chain(BOTH));
      const res = await call({ amount: 500 });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/choose/i);
      expect(transactionCreate).not.toHaveBeenCalled();
    });

    it("uses the only method saved without asking", async () => {
      deliveryFindById.mockReturnValue(chain(FULL_BANK));
      const res = await call({ amount: 500 });

      expect(res.statusCode).toBe(201);
      expect(transactionCreate.mock.calls[0][0].meta.payout.method).toBe("bank");
    });

    it("refuses a method the rider has not saved", async () => {
      deliveryFindById.mockReturnValue(chain(FULL_BANK));
      const res = await call({ amount: 500, method: "upi" });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/UPI/i);
      expect(transactionCreate).not.toHaveBeenCalled();
    });
  });

  it("refuses when the rider has saved no payout destination", async () => {
    deliveryFindById.mockReturnValue(
      chain({ _id: RIDER_ID, name: "Asha", phone: "9990001111" }),
    );
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    const res = await call({ amount: 500 });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/payout details/i);
    expect(transactionCreate).not.toHaveBeenCalled();
  });

  it("accepts a UPI-only rider", async () => {
    deliveryFindById.mockReturnValue(
      chain({ _id: RIDER_ID, name: "Asha", upiId: "asha@okhdfc" }),
    );
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    const res = await call({ amount: 500 });

    expect(res.statusCode).toBe(201);
    expect(transactionCreate.mock.calls[0][0].meta.payout.upiId).toBe("asha@okhdfc");
  });

  it("accepts a QR-only rider", async () => {
    deliveryFindById.mockReturnValue(
      chain({ _id: RIDER_ID, name: "Asha", qrImageUrl: "https://cdn/qr.png" }),
    );
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    expect((await call({ amount: 500 })).statusCode).toBe(201);
  });

  it("rejects a half-filled bank account with no UPI or QR", async () => {
    deliveryFindById.mockReturnValue(
      chain({ _id: RIDER_ID, accountNumber: "123456789012", accountHolder: "ASHA" }),
    );
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    expect((await call({ amount: 500 })).statusCode).toBe(400);
  });

  it("enforces the minimum withdrawal", async () => {
    deliveryFindById.mockReturnValue(chain(FULL_BANK));
    transactionFind.mockReturnValue(chain(EARNINGS_ONLY));

    const res = await call({ amount: 50 });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Minimum/i);
    // Checked before the DB is touched, so a nonsense amount costs nothing.
    expect(deliveryFindById).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    expect((await call({ amount: 0 })).statusCode).toBe(400);
    expect((await call({ amount: -500 })).statusCode).toBe(400);
    expect((await call({})).statusCode).toBe(400);
  });

  it("allows only one request in flight at a time", async () => {
    deliveryFindById.mockReturnValue(chain(FULL_BANK));
    transactionFind.mockReturnValue(
      chain([...EARNINGS_ONLY, { type: "Withdrawal", status: "Pending", amount: -300 }]),
    );

    const res = await call({ amount: 500 });

    expect(res.statusCode).toBe(409);
    expect(transactionCreate).not.toHaveBeenCalled();
  });

  it("ignores cash-settlement rows, so the balance matches the earnings screen", async () => {
    deliveryFindById.mockReturnValue(chain(FULL_BANK));
    transactionFind.mockReturnValue(
      chain([
        ...EARNINGS_ONLY,
        // Cash the rider deposited back. It is not earnings and must not
        // move the withdrawable balance in either direction.
        { type: "Cash Settlement", status: "Settled", amount: -370 },
        { type: "Cash Collection", status: "Settled", amount: 370 },
      ]),
    );

    const res = await call({ amount: 2000 });

    expect(res.statusCode).toBe(201);
    expect(transactionCreate.mock.calls[0][0].meta.requestedBalance).toBe(2000);
  });

  it("subtracts already-settled withdrawals from what is left", async () => {
    deliveryFindById.mockReturnValue(chain(FULL_BANK));
    transactionFind.mockReturnValue(
      chain([...EARNINGS_ONLY, { type: "Withdrawal", status: "Settled", amount: -1800 }]),
    );

    const res = await call({ amount: 500 });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Insufficient balance. Available: ₹200/);
  });

  it("returns 404 when the rider record is gone", async () => {
    deliveryFindById.mockReturnValue(chain(null));

    expect((await call({ amount: 500 })).statusCode).toBe(404);
  });
});
