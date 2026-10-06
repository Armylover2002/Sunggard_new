import { jest } from "@jest/globals";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const mockCustomerFindById = jest.fn();
const mockDeliveryFindById = jest.fn();
const mockCustomerUpdateMany = jest.fn();
const mockDeliveryUpdateMany = jest.fn();

const chain = (result) => ({
  select() {
    return this;
  },
  lean() {
    return Promise.resolve(result);
  },
});

jest.unstable_mockModule("../app/models/customer.js", () => ({
  default: { findById: mockCustomerFindById, updateMany: mockCustomerUpdateMany },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: mockDeliveryFindById, updateMany: mockDeliveryUpdateMany },
}));

const { verifyToken } = await import("../app/middleware/authMiddleware.js");
const { claimRoleSession } = await import("../app/services/sessionService.js");

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("one phone number, one role at a time", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a customer token issued before the rider logged in on the same number", async () => {
    mockCustomerFindById.mockReturnValue(chain({ sessionVersion: 2 }));
    const token = jwt.sign({ id: "c1", role: "customer", sv: 1 }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    const next = jest.fn();

    await verifyToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("accepts a token whose session version is still current", async () => {
    mockCustomerFindById.mockReturnValue(chain({ sessionVersion: 2 }));
    const token = jwt.sign({ id: "c1", role: "customer", sv: 2 }, process.env.JWT_SECRET);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    const next = jest.fn();

    await verifyToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe("c1");
  });

  it("logging in as a rider signs out the customer on the same number, not the rider's other devices", async () => {
    mockCustomerUpdateMany.mockResolvedValue({});

    await claimRoleSession("delivery", "+919988776655");

    expect(mockCustomerUpdateMany).toHaveBeenCalledWith(
      { phone: { $regex: "9988776655$" } },
      { $inc: { sessionVersion: 1 } },
    );
    expect(mockDeliveryUpdateMany).not.toHaveBeenCalled();
  });
});
