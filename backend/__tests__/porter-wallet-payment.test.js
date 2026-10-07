import { jest } from "@jest/globals";

const parcelFindOneAndUpdate = jest.fn();
const parcelFindById = jest.fn();
const parcelFindByIdAndUpdate = jest.fn();
const parcelUpdateOne = jest.fn().mockResolvedValue({});
const debitWallet = jest.fn().mockResolvedValue({});
const creditWallet = jest.fn().mockResolvedValue({});
const getCustomerBalance = jest.fn();

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    findOneAndUpdate: parcelFindOneAndUpdate,
    findById: parcelFindById,
    findByIdAndUpdate: parcelFindByIdAndUpdate,
    updateOne: parcelUpdateOne,
  },
}));
jest.unstable_mockModule("../app/services/finance/walletService.js", () => ({
  debitWallet,
  creditWallet,
  getCustomerBalance,
}));
jest.unstable_mockModule("../app/services/porter/customerLedgerService.js", () => ({
  pushCustomerTransaction: jest.fn().mockResolvedValue({}),
  recordPorterLedgerEntry: jest.fn().mockResolvedValue({}),
}));
jest.unstable_mockModule("../app/services/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { payBookingFromWallet, refundWalletBooking, assertWalletCovers, bookingPayableAmount } =
  await import("../app/services/porter/porterWalletPaymentService.js");

const parcel = { _id: "6ac00000000000000000ab12", customerId: "cust1", fare: 318, payableFare: 300 };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("wallet payment for a booking", () => {
  it("charges what the customer actually pays (coupon taken off)", () => {
    expect(bookingPayableAmount(parcel)).toBe(300);
    expect(bookingPayableAmount({ fare: 318 })).toBe(318);
  });

  it("refuses up front when the wallet cannot cover the booking", async () => {
    getCustomerBalance.mockResolvedValue(100);
    await expect(assertWalletCovers("cust1", 300)).rejects.toMatchObject({
      statusCode: 402,
      code: "INSUFFICIENT_WALLET",
      balance: 100,
      required: 300,
    });
  });

  it("allows it when the balance is exactly enough", async () => {
    getCustomerBalance.mockResolvedValue(300);
    await expect(assertWalletCovers("cust1", 300)).resolves.toBe(300);
  });

  it("debits the wallet once and marks the booking paid", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce({ ...parcel }); // claim won
    parcelFindByIdAndUpdate.mockResolvedValueOnce({ ...parcel, paymentStatus: "PAID" });

    const paid = await payBookingFromWallet(parcel);

    expect(debitWallet).toHaveBeenCalledTimes(1);
    expect(debitWallet.mock.calls[0][0]).toMatchObject({
      ownerType: "CUSTOMER",
      ownerId: "cust1",
      amount: 300,
      ledgerType: "WALLET_PAYMENT",
    });
    expect(paid.paymentStatus).toBe("PAID");
  });

  it("does not debit again when the booking was already paid (claim lost)", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce(null);
    parcelFindById.mockResolvedValueOnce({ ...parcel, paymentStatus: "PAID" });

    await payBookingFromWallet(parcel);

    expect(debitWallet).not.toHaveBeenCalled();
  });

  it("releases the claim and reports 402 if the wallet turns out to be short", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce({ ...parcel });
    debitWallet.mockRejectedValueOnce(new Error("Insufficient available balance"));

    await expect(payBookingFromWallet(parcel)).rejects.toMatchObject({
      statusCode: 402,
      code: "INSUFFICIENT_WALLET",
    });
    expect(parcelUpdateOne).toHaveBeenCalledWith(
      { _id: parcel._id },
      { $set: { "walletPayment.paidAt": null, "walletPayment.amount": 0 } },
    );
  });
});

describe("cancelling a wallet booking", () => {
  it("credits the amount that was charged back to the wallet, once", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce({
      ...parcel,
      paymentStatus: "REFUNDED",
      walletPayment: { amount: 300 },
    });

    const result = await refundWalletBooking({ parcelId: parcel._id, reason: "Cancelled" });

    expect(creditWallet).toHaveBeenCalledTimes(1);
    expect(creditWallet.mock.calls[0][0]).toMatchObject({
      ownerType: "CUSTOMER",
      ownerId: "cust1",
      amount: 300,
      ledgerType: "WALLET_REFUND",
    });
    expect(result).toMatchObject({ ok: true, via: "WALLET", status: "REFUNDED", amountRupees: 300 });
  });

  it("is a no-op for anything that is not a paid, un-refunded wallet booking", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce(null);

    expect(await refundWalletBooking({ parcelId: parcel._id })).toBeNull();
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("puts the booking back to PAID if the wallet credit fails, so it can be retried", async () => {
    parcelFindOneAndUpdate.mockResolvedValueOnce({
      ...parcel,
      walletPayment: { amount: 300 },
    });
    creditWallet.mockRejectedValueOnce(new Error("db down"));

    const result = await refundWalletBooking({ parcelId: parcel._id });

    expect(result).toMatchObject({ ok: false, via: "WALLET" });
    expect(parcelUpdateOne).toHaveBeenCalledWith(
      { _id: parcel._id },
      { $set: { "walletPayment.refundedAt": null, paymentStatus: "PAID" } },
    );
  });
});
