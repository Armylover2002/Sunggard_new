import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockTransactionFindOneAndUpdate = jest.fn();
const mockTransactionUpdateMany = jest.fn().mockResolvedValue({});
const mockParcelUpdateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
const mockCashDepositFindById = jest.fn();
const mockDeliveryFindById = jest.fn(() => ({
  select: () => ({ lean: () => ({ catch: () => null }) }),
}));
const mockNotificationCreate = jest.fn(() => ({ catch: () => {} }));
const mockEmitToDelivery = jest.fn();
const mockGetRiderCashStatus = jest.fn().mockResolvedValue({ blocked: false });

jest.unstable_mockModule("../app/models/cashDeposit.js", () => ({
  default: { findById: mockCashDepositFindById },
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: { updateMany: mockParcelUpdateMany },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: mockDeliveryFindById },
}));

jest.unstable_mockModule("../app/models/notification.js", () => ({
  default: { create: mockNotificationCreate },
}));

jest.unstable_mockModule("../app/modules/notifications/notification.i18n.js", () => ({
  translate: jest.fn((lang, key) => key),
  normalizeLanguage: jest.fn(() => "en"),
}));

jest.unstable_mockModule("../app/models/transaction.js", () => ({
  default: {
    findOneAndUpdate: mockTransactionFindOneAndUpdate,
    updateMany: mockTransactionUpdateMany,
  },
}));

jest.unstable_mockModule("../app/models/setting.js", () => ({ default: {} }));

jest.unstable_mockModule("../app/services/orderSocketEmitter.js", () => ({
  emitToDelivery: mockEmitToDelivery,
}));

jest.unstable_mockModule("../app/services/porter/riderCashLimitService.js", () => ({
  getRiderCashStatus: mockGetRiderCashStatus,
}));

const { recordCodCollection, reviewCashDeposit } = await import(
  "../app/services/riderCashService.js"
);

const RIDER = new mongoose.Types.ObjectId();
const PARCEL = new mongoose.Types.ObjectId();
const DEPOSIT = new mongoose.Types.ObjectId();
const ADMIN = new mongoose.Types.ObjectId();

describe("a rider's collected COD cash is not shown as Settled until it's actually remitted", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionFindOneAndUpdate.mockResolvedValue({ _id: "txn1" });
  });

  it("recordCodCollection writes Pending at the moment the rider collects cash, not Settled", async () => {
    await recordCodCollection({ riderId: RIDER, kind: "parcel", refId: PARCEL, amount: 263 });

    const write = mockTransactionFindOneAndUpdate.mock.calls[0][1].$set;
    expect(write.status).toBe("Pending");
    expect(write.amount).toBe(263);
  });

  it("approving the deposit that covers this booking flips its Cash Collection row to Settled", async () => {
    const deposit = {
      _id: DEPOSIT,
      riderId: RIDER,
      amount: 263,
      status: "PENDING",
      method: "CASH",
      items: [{ kind: "parcel", refId: PARCEL, amount: 263, label: "PCL" }],
      save: jest.fn().mockResolvedValue(true),
      toObject: () => ({ _id: DEPOSIT, status: "APPROVED" }),
    };
    mockCashDepositFindById.mockResolvedValue(deposit);

    await reviewCashDeposit({ depositId: String(DEPOSIT), adminId: String(ADMIN), approve: true });

    expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
      {
        reference: { $in: [`CASH-COL-PCL-${String(PARCEL)}`] },
        type: "Cash Collection",
      },
      { $set: { status: "Settled" } },
    );
  });

  it("rejecting a deposit never touches the Cash Collection row — the cash is still with the rider", async () => {
    const deposit = {
      _id: DEPOSIT,
      riderId: RIDER,
      amount: 263,
      status: "PENDING",
      method: "CASH",
      items: [{ kind: "parcel", refId: PARCEL, amount: 263, label: "PCL" }],
      save: jest.fn().mockResolvedValue(true),
      toObject: () => ({ _id: DEPOSIT, status: "REJECTED" }),
    };
    mockCashDepositFindById.mockResolvedValue(deposit);

    await reviewCashDeposit({ depositId: String(DEPOSIT), adminId: String(ADMIN), approve: false });

    expect(mockTransactionUpdateMany).not.toHaveBeenCalled();
    expect(mockParcelUpdateMany).not.toHaveBeenCalled();
  });
});
