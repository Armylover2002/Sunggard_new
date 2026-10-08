import { jest } from "@jest/globals";

const parcelFindById = jest.fn();
const parcelFind = jest.fn();
const ratingCreate = jest.fn();
const ratingFind = jest.fn();
const deliveryUpdateOne = jest.fn();
const deliveryFindById = jest.fn();

const chain = (result) => ({
  sort: () => chain(result),
  limit: () => chain(result),
  select: () => chain(result),
  lean: async () => result,
  then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
});

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    findById: (...a) => ({ select: async () => parcelFindById(...a) }),
    find: (...a) => chain(parcelFind(...a)),
  },
}));
jest.unstable_mockModule("../app/models/delivery.js", () => ({
  default: {
    updateOne: (...a) => deliveryUpdateOne(...a),
    findById: (...a) => chain(deliveryFindById(...a)),
  },
}));
jest.unstable_mockModule("../app/models/riderRating.js", () => ({
  RIDER_RATING_TAGS: ["polite", "on_time", "late", "rude"],
  default: {
    create: ratingCreate,
    find: (...a) => chain(ratingFind(...a)),
  },
}));
jest.unstable_mockModule("../app/services/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { submitRiderRating, getPendingRiderRating } = await import(
  "../app/controller/riderRatingController.js"
);

const PARCEL_ID = "6ac00000000000000000ab12";
const RIDER_ID = "6ac00000000000000000cd34";

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const call = async (body, user = { id: "cust1" }) => {
  const res = makeRes();
  await submitRiderRating({ body, user }, res);
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
};
const delivered = (extra = {}) => ({
  customerId: "cust1",
  status: "DELIVERED",
  deliveryPartnerId: RIDER_ID,
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  deliveryUpdateOne.mockReturnValue(Promise.resolve({}));
});

describe("submitting a rider rating", () => {
  it.each([0, 6, "x", null])("rejects a rating of %p", async (rating) => {
    const { status } = await call({ parcelId: PARCEL_ID, rating });
    expect(status).toBe(400);
    expect(ratingCreate).not.toHaveBeenCalled();
  });

  it("only the booking's own customer can rate", async () => {
    parcelFindById.mockResolvedValueOnce(delivered({ customerId: "someone-else" }));
    const { status } = await call({ parcelId: PARCEL_ID, rating: 5 });
    expect(status).toBe(403);
    expect(ratingCreate).not.toHaveBeenCalled();
  });

  it("only after the courier is delivered", async () => {
    parcelFindById.mockResolvedValueOnce(delivered({ status: "SEARCHING" }));
    const { status } = await call({ parcelId: PARCEL_ID, rating: 5 });
    expect(status).toBe(409);
  });

  it("not when there was no rider", async () => {
    parcelFindById.mockResolvedValueOnce(delivered({ deliveryPartnerId: null }));
    const { status } = await call({ parcelId: PARCEL_ID, rating: 5 });
    expect(status).toBe(409);
  });

  it("saves the rating and moves the rider's average with one atomic update", async () => {
    parcelFindById.mockResolvedValueOnce(delivered());
    ratingCreate.mockResolvedValueOnce({ rating: 4, tags: ["polite"], comment: "Nice" });

    const { status } = await call({
      parcelId: PARCEL_ID,
      rating: 4,
      tags: ["polite", "not_a_real_tag", "polite"],
      comment: "  Nice  ",
    });

    expect(status).toBe(201);
    // junk tags dropped, duplicates collapsed, comment trimmed
    expect(ratingCreate.mock.calls[0][0]).toMatchObject({
      riderId: RIDER_ID,
      customerId: "cust1",
      rating: 4,
      tags: ["polite"],
      comment: "Nice",
    });
    expect(deliveryUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = deliveryUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: RIDER_ID });
    expect(Array.isArray(pipeline)).toBe(true); // an aggregation-pipeline update, not read-modify-write
  });

  it("a second rating for the same booking is refused and never counts twice", async () => {
    parcelFindById.mockResolvedValueOnce(delivered());
    ratingCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: 11000 }));

    const { status, body } = await call({ parcelId: PARCEL_ID, rating: 5 });

    expect(status).toBe(400);
    expect(body.message).toMatch(/already rated/i);
    expect(deliveryUpdateOne).not.toHaveBeenCalled();
  });

  it("still saves the rating if the average update fails", async () => {
    parcelFindById.mockResolvedValueOnce(delivered());
    ratingCreate.mockResolvedValueOnce({ rating: 5, tags: [], comment: "" });
    deliveryUpdateOne.mockReturnValueOnce(Promise.reject(new Error("db blip")));

    const { status } = await call({ parcelId: PARCEL_ID, rating: 5 });
    expect(status).toBe(201);
  });
});

describe("the pending-rating popup lookup", () => {
  const run = async () => {
    const res = makeRes();
    await getPendingRiderRating({ user: { id: "cust1" } }, res);
    return res.json.mock.calls[0][0];
  };

  it("offers nothing when there is no recent delivery", async () => {
    parcelFind.mockReturnValueOnce([]);
    expect((await run()).result).toBeNull();
  });

  it("offers nothing when every recent delivery is already rated", async () => {
    parcelFind.mockReturnValueOnce([{ _id: PARCEL_ID, deliveryPartnerId: RIDER_ID }]);
    ratingFind.mockReturnValueOnce([{ parcelId: PARCEL_ID }]);
    expect((await run()).result).toBeNull();
  });

  it("offers the newest unrated delivery with the rider's details", async () => {
    parcelFind.mockReturnValueOnce([
      { _id: PARCEL_ID, deliveryPartnerId: RIDER_ID },
      { _id: "6ac00000000000000000ee99", deliveryPartnerId: RIDER_ID },
    ]);
    ratingFind.mockReturnValueOnce([]);
    deliveryFindById.mockReturnValueOnce({
      _id: RIDER_ID,
      name: "Vishal",
      profileImage: "",
      rating: 4.5,
      ratingCount: 12,
    });

    const { result } = await run();

    expect(result.parcelId).toBe(PARCEL_ID);
    expect(result.reference).toBe("PCL-00AB12");
    expect(result.rider).toMatchObject({ name: "Vishal", rating: 4.5, ratingCount: 12 });
  });
});
