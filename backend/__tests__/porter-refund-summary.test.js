import { summarizeRefund, REFUND_STATE } from "../app/services/porter/porterRefundService.js";

const payment = (extra = {}) => ({
  amount: 31800, // paise
  status: "CAPTURED",
  refundedAmount: 0,
  refunds: [],
  instrument: { method: "upi" },
  ...extra,
});

describe("summarizeRefund", () => {
  it("returns nothing when there is no online payment", () => {
    expect(summarizeRefund(null, { status: "CANCELLED" })).toBeNull();
  });

  it("returns nothing for a live paid booking", () => {
    expect(summarizeRefund(payment(), { status: "SEARCHING" })).toBeNull();
  });

  it("is PENDING when the booking is cancelled and paid but nothing was refunded", () => {
    expect(summarizeRefund(payment(), { status: "CANCELLED" })).toMatchObject({
      state: REFUND_STATE.PENDING,
      amount: 318,
    });
  });

  it("is REFUNDED, in rupees, with the gateway's own progress", () => {
    const result = summarizeRefund(
      payment({
        status: "REFUNDED",
        refundedAmount: 31800,
        refundedAt: new Date("2026-10-07T16:29:00Z"),
        refunds: [{ gatewayRefundId: "rfnd_1", amount: 31800, status: "processed" }],
      }),
      { status: "CANCELLED" },
    );
    expect(result).toMatchObject({
      state: REFUND_STATE.REFUNDED,
      amount: 318,
      gatewayStatus: "processed",
      gatewayRefundId: "rfnd_1",
    });
  });

  it("is PARTIAL when only part of the payment came back", () => {
    const result = summarizeRefund(
      payment({ status: "PARTIALLY_REFUNDED", refundedAmount: 10000 }),
      { status: "CANCELLED" },
    );
    expect(result).toMatchObject({ state: REFUND_STATE.PARTIAL, amount: 100, paidAmount: 318 });
  });

  it("is FAILED, with the reason, when the gateway refused the refund", () => {
    const result = summarizeRefund(
      payment({ refundFailedAt: new Date(), refundFailureReason: "Insufficient balance" }),
      { status: "CANCELLED" },
    );
    expect(result).toMatchObject({
      state: REFUND_STATE.FAILED,
      amount: 318,
      reason: "Insufficient balance",
    });
  });
});
