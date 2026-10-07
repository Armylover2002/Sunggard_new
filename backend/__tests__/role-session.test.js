import { jest } from "@jest/globals";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const mockCustomerFindById = jest.fn();
const mockDeliveryFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn();

const chain = (result) => ({
  select() {
    return this;
  },
  lean() {
    return Promise.resolve(result);
  },
});

jest.unstable_mockModule("../app/models/customer.js", () => ({
  default: { findById: mockCustomerFindById },
}));

jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: { findById: mockDeliveryFindById },
}));

const { verifyToken } = await import("../app/middleware/authMiddleware.js");
const { bumpOwnSession } = await import("../app/services/sessionService.js");

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe("a single active session per account, never across roles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a token whose session version is older than the account's current one", async () => {
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

  it("bumping one account's own session never reads or writes the other model", async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ sessionVersion: 3 });
    const DeliveryModel = { findByIdAndUpdate: mockFindByIdAndUpdate };

    const newVersion = await bumpOwnSession(DeliveryModel, "rider1");

    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "rider1",
      { $inc: { sessionVersion: 1 } },
      { new: true },
    );
    expect(newVersion).toBe(3);
    // The customer and delivery model mocks above are never touched by this
    // call at all — same phone number or not, a login for one account only
    // ever reads/writes that one account. A customer and a rider sharing a
    // phone number stay logged in to both apps at once.
    expect(mockCustomerFindById).not.toHaveBeenCalled();
    expect(mockDeliveryFindById).not.toHaveBeenCalled();
  });
});
