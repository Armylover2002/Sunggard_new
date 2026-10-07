import { jest } from "@jest/globals";

const findOneAndUpdate = jest.fn();
const updateOne = jest.fn().mockResolvedValue({});
const creditWallet = jest.fn().mockResolvedValue({});

jest.unstable_mockModule("../app/models/porterPayment.js", () => ({
  default: { findOneAndUpdate, updateOne, findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() },
}));
jest.unstable_mockModule("../app/services/finance/walletService.js", () => ({
  creditWallet,
  getCustomerBalance: jest.fn().mockResolvedValue(0),
}));
jest.unstable_mockModule("../app/services/payment/providerRegistry.js", () => ({
  getActivePaymentProvider: jest.fn(() => ({ isConfigured: () => true, providerName: "RAZORPAY" })),
}));
jest.unstable_mockModule("../app/services/porter/porterPaymentService.js", () => ({
  applyPorterStatus: jest.fn(),
  absorbGatewayEntity: jest.fn(),
}));
jest.unstable_mockModule("../app/services/porter/customerLedgerService.js", () => ({
  pushCustomerTransaction: jest.fn().mockResolvedValue({}),
}));
jest.unstable_mockModule("../app/services/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { applyWalletTopupSideEffects, parseTopupAmount } = await import(
  "../app/services/porter/walletTopupService.js"
);

const captured = (extra = {}) => ({
  _id: "pay1",
  purpose: "WALLET_TOPUP",
  customerId: "cust1",
  amount: 50000, // paise
  currency: "INR",
  status: "CAPTURED",
  walletCreditedAt: null,
  isPaid() {
    return this.status === "CAPTURED";
  },
  ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe("wallet top-up amount", () => {
  it("accepts a normal amount", () => {
    expect(parseTopupAmount(500)).toBe(500);
    expect(parseTopupAmount("250.5")).toBe(250.5);
  });

  it.each([0, -5, "abc", null, 5, 10000000])("rejects %p", (value) => {
    expect(() => parseTopupAmount(value)).toThrow();
  });
});

describe("crediting a top-up", () => {
  it("credits the wallet once the payment is captured", async () => {
    findOneAndUpdate.mockResolvedValueOnce(captured({ walletCreditedAt: new Date() }));

    const result = await applyWalletTopupSideEffects(captured());

    expect(result).toMatchObject({ credited: true, amount: 500 });
    expect(creditWallet).toHaveBeenCalledTimes(1);
    expect(creditWallet.mock.calls[0][0]).toMatchObject({
      ownerType: "CUSTOMER",
      ownerId: "cust1",
      amount: 500,
      ledgerType: "WALLET_TOPUP",
    });
  });

  it("never credits a payment that is not captured", async () => {
    const result = await applyWalletTopupSideEffects(captured({ status: "PENDING" }));

    expect(result).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("does not credit twice when a verify and a webhook land together", async () => {
    findOneAndUpdate.mockResolvedValueOnce(null); // lost the atomic claim

    const result = await applyWalletTopupSideEffects(captured());

    expect(result).toMatchObject({ credited: false, duplicate: true });
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("does nothing for a payment already credited", async () => {
    const result = await applyWalletTopupSideEffects(captured({ walletCreditedAt: new Date() }));

    expect(result).toMatchObject({ credited: false, duplicate: true });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("gives the claim back if the wallet credit fails, so it can be retried", async () => {
    findOneAndUpdate.mockResolvedValueOnce(captured({ walletCreditedAt: new Date() }));
    creditWallet.mockRejectedValueOnce(new Error("db down"));

    await expect(applyWalletTopupSideEffects(captured())).rejects.toThrow("db down");
    expect(updateOne).toHaveBeenCalledWith({ _id: "pay1" }, { $set: { walletCreditedAt: null } });
  });

  it("ignores payments that are not wallet top-ups", async () => {
    expect(await applyWalletTopupSideEffects(captured({ purpose: "BOOKING" }))).toBeNull();
  });
});
