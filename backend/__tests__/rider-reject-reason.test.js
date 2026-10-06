import { jest } from "@jest/globals";

const mockFindByIdAndUpdate = jest.fn();

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findByIdAndUpdate: mockFindByIdAndUpdate },
}));

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {},
}));

const { rejectDeliveryPartner } = await import("../app/controller/admin/deliveryController.js");

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("admin rejects a rider application with a reason", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses a rejection without a usable reason", async () => {
    const res = makeRes();
    await rejectDeliveryPartner({ params: { id: "abc" }, body: { reason: "  no  " } }, res);

    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("stores the reason and marks the application rejected", async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ _id: "abc" });
    const res = makeRes();
    await rejectDeliveryPartner(
      { params: { id: "abc" }, body: { reason: "Aadhar photo is blurry" } },
      res,
    );

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "abc",
      expect.objectContaining({
        applicationStatus: "rejected",
        isVerified: false,
        rejectionReason: "Aadhar photo is blurry",
        rejectedAt: expect.any(Date),
      }),
      { new: true },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
