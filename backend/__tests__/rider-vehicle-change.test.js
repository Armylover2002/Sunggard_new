import { jest } from "@jest/globals";

const findById = jest.fn();
const parcelExists = jest.fn();
const adminFind = jest.fn();
const notificationCreate = jest.fn().mockResolvedValue({});
const notificationInsertMany = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule("../app/models/delivery.js", () => ({ default: { findById } }));
jest.unstable_mockModule("../app/models/parcel.js", () => ({ default: { exists: parcelExists } }));
jest.unstable_mockModule("../app/models/admin.js", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => adminFind() }) }) },
}));
jest.unstable_mockModule("../app/models/notification.js", () => ({
  default: { create: notificationCreate, insertMany: notificationInsertMany },
}));
jest.unstable_mockModule("../app/services/firebaseService.js", () => ({
  clearRiderPresence: jest.fn().mockResolvedValue(),
}));
jest.unstable_mockModule("../app/services/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { submitVehicleChange, cancelVehicleChange, approveVehicleChange, rejectVehicleChange } =
  await import("../app/services/riderVehicleChangeService.js");

/** A rider document: plain fields plus a save() that records it ran. */
const makeRider = (extra = {}) => ({
  _id: "rider1",
  name: "Vishal",
  isVerified: true,
  isOnline: true,
  applicationStatus: "approved",
  vehicleType: "bike",
  vehicleNumber: "MH12AB0000",
  drivingLicenseNumber: "DL1234567890123",
  vehicleChange: { status: "none" },
  save: jest.fn().mockResolvedValue(),
  ...extra,
});

const pendingRider = () =>
  makeRider({
    isVerified: false,
    isOnline: false,
    applicationStatus: "pending",
    vehicleChange: {
      status: "pending",
      previous: { vehicleType: "bike", vehicleNumber: "MH12AB0000", drivingLicenseNumber: "DL1234567890123" },
      requested: { vehicleType: "scooter" },
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  parcelExists.mockResolvedValue(null);
  adminFind.mockReturnValue([{ _id: "admin1" }]);
});

describe("a rider asking to change their vehicle details", () => {
  it("refuses a cycle — it is no longer a vehicle type", async () => {
    findById.mockResolvedValueOnce(makeRider());
    await expect(submitVehicleChange("rider1", { vehicleType: "cycle" })).rejects.toThrow(/Bike or Scooter/);
  });

  it("refuses a malformed plate or licence", async () => {
    findById.mockResolvedValue(makeRider());
    await expect(submitVehicleChange("rider1", { vehicleNumber: "12345" })).rejects.toThrow(/plate/i);
    await expect(submitVehicleChange("rider1", { drivingLicenseNumber: "abc" })).rejects.toThrow(/licence/i);
  });

  it("refuses when nothing actually changed", async () => {
    findById.mockResolvedValueOnce(makeRider());
    await expect(
      submitVehicleChange("rider1", { vehicleType: "bike", vehicleNumber: "MH 12 AB 0000" }),
    ).rejects.toThrow(/Nothing has changed/);
  });

  it("waits until the rider's current delivery is finished", async () => {
    findById.mockResolvedValueOnce(makeRider());
    parcelExists.mockResolvedValueOnce({ _id: "p1" });
    await expect(submitVehicleChange("rider1", { vehicleType: "scooter" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses an account that is not approved", async () => {
    findById.mockResolvedValueOnce(makeRider({ isVerified: false }));
    await expect(submitVehicleChange("rider1", { vehicleType: "scooter" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("holds the request, keeps the approved details, and puts the account on hold", async () => {
    const rider = makeRider();
    findById.mockResolvedValueOnce(rider);

    await submitVehicleChange("rider1", { vehicleType: "scooter", vehicleNumber: "KA 05 MN 8921" });

    // requested values are held, with a snapshot of what they were
    expect(rider.vehicleChange).toMatchObject({
      status: "pending",
      previous: { vehicleType: "bike", vehicleNumber: "MH12AB0000", drivingLicenseNumber: "DL1234567890123" },
      requested: { vehicleType: "scooter", vehicleNumber: "KA05MN8921" },
    });
    // the live (approved) details are untouched until an admin approves
    expect(rider.vehicleType).toBe("bike");
    expect(rider.vehicleNumber).toBe("MH12AB0000");
    // account is waiting for approval again
    expect(rider.isVerified).toBe(false);
    expect(rider.applicationStatus).toBe("pending");
    expect(rider.isOnline).toBe(false);
    expect(rider.save).toHaveBeenCalled();
    // admins are told what is changing
    const rows = notificationInsertMany.mock.calls[0][0];
    expect(rows[0].message).toMatch(/Bike → Scooter/);
  });

  it("only records the fields that changed", async () => {
    const rider = makeRider();
    findById.mockResolvedValueOnce(rider);
    await submitVehicleChange("rider1", { vehicleType: "bike", vehicleNumber: "KA05MN8921" });
    expect(Object.keys(rider.vehicleChange.requested)).toEqual(["vehicleNumber"]);
  });

  it("a second request replaces the first but keeps the original 'before' snapshot", async () => {
    const rider = pendingRider();
    findById.mockResolvedValueOnce(rider);
    await submitVehicleChange("rider1", { vehicleNumber: "KA05MN8921" });
    expect(rider.vehicleChange.previous.vehicleType).toBe("bike");
    expect(rider.vehicleChange.requested).toEqual({ vehicleNumber: "KA05MN8921" });
  });
});

describe("admin decisions on a vehicle change", () => {
  it("approve applies the new details and re-activates the account", async () => {
    const rider = pendingRider();
    findById.mockResolvedValueOnce(rider);

    const result = await approveVehicleChange("rider1");

    expect(result.vehicleType).toBe("scooter");
    expect(result.isVerified).toBe(true);
    expect(result.applicationStatus).toBe("approved");
    expect(result.vehicleChange.status).toBe("approved");
    expect(notificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "rider1", recipientModel: "Delivery" }),
    );
  });

  it("reject keeps the old details, tells the rider why, and lets them back in", async () => {
    const rider = pendingRider();
    findById.mockResolvedValueOnce(rider);

    const result = await rejectVehicleChange("rider1", "Plate photo does not match");

    expect(result.vehicleType).toBe("bike"); // never overwritten
    expect(result.isVerified).toBe(true);
    expect(result.applicationStatus).toBe("approved"); // not marked a rejected applicant
    expect(result.vehicleChange).toMatchObject({
      status: "rejected",
      rejectionReason: "Plate photo does not match",
    });
    expect(notificationCreate.mock.calls[0][0].message).toContain("Plate photo does not match");
  });

  it("do nothing for a rider with no pending change", async () => {
    findById.mockResolvedValue(makeRider());
    expect(await approveVehicleChange("rider1")).toBeNull();
    expect(await rejectVehicleChange("rider1", "reason here")).toBeNull();
  });

  it("a rider can withdraw their own pending request", async () => {
    const rider = pendingRider();
    findById.mockResolvedValueOnce(rider);

    const result = await cancelVehicleChange("rider1");

    expect(result.isVerified).toBe(true);
    expect(result.vehicleChange.status).toBe("none");
    expect(result.vehicleType).toBe("bike");
  });
});
