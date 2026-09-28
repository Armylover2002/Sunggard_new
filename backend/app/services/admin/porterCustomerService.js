import mongoose from "mongoose";
import Customer from "../../models/customer.js";
import Parcel from "../../models/parcel.js";
import { escapeRegex } from "../../utils/regex.js";
import { visibleParcels } from "../bookingCheckoutService.js";

/**
 * Admin "Porter Customers" desk.
 *
 * Porter bookings live in `models/parcel.js` (the pickup-service flow). The
 * listing is anchored on the bookings, not on the customer table: it starts
 * from Parcel (indexed on customerId), groups by customer, and only then
 * looks up the customer profile. That keeps the query cheap regardless of
 * how many millions of shoppers never touched Porter — this desk only ever
 * fans out over people who actually booked.
 */

/** A booking is finished, one way or another; only DELIVERED counts as money actually earned. */
const DELIVERED = "DELIVERED";
const CANCELLED = "CANCELLED";

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const SORT_FIELDS = {
  totalBookings: "totalBookings",
  totalSpent: "totalSpent",
  lastBookingAt: "lastBookingAt",
  joinedDate: "customer.createdAt",
};

/**
 * Skips bookings whose payment sheet never closed.
 *
 * Those rows are written before the customer pays, so counting them made
 * this desk claim bookings that do not exist — a customer who opened the
 * pay screen twice and walked away read as "2 total bookings", with a last
 * booking date, next to a lifetime spend of zero.
 */
const bookingUnionPipeline = (extraMatch = {}) => [
  { $match: visibleParcels(extraMatch) },
  { $project: { customerId: 1, fare: 1, status: 1, createdAt: 1 } },
];

export async function getPorterCustomersData({
  page,
  limit,
  skip,
  search = "",
  status = "all",
  sortBy = "totalBookings",
  sortDir = "desc",
}) {
  const sortField = SORT_FIELDS[sortBy] || SORT_FIELDS.totalBookings;
  const direction = sortDir === "asc" ? 1 : -1;

  const customerMatch = { "customer.role": "user" };
  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    const re = new RegExp(escapeRegex(trimmedSearch), "i");
    customerMatch.$or = [
      { "customer.name": re },
      { "customer.email": re },
      { "customer.phone": re },
    ];
  }
  if (status === "active") customerMatch["customer.isActive"] = { $ne: false };
  if (status === "inactive") customerMatch["customer.isActive"] = false;

  const pipeline = [
    ...bookingUnionPipeline(),
    {
      $group: {
        _id: "$customerId",
        totalBookings: { $sum: 1 },
        deliveredBookings: { $sum: { $cond: [{ $eq: ["$status", DELIVERED] }, 1, 0] } },
        cancelledBookings: { $sum: { $cond: [{ $eq: ["$status", CANCELLED] }, 1, 0] } },
        totalSpent: { $sum: { $cond: [{ $eq: ["$status", DELIVERED] }, "$fare", 0] } },
        lastBookingAt: { $max: "$createdAt" },
      },
    },
    {
      $lookup: {
        from: Customer.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "customer",
      },
    },
    { $unwind: "$customer" },
    { $match: customerMatch },
    {
      $project: {
        _id: 0,
        id: { $toString: "$customer._id" },
        name: { $ifNull: ["$customer.name", "Unnamed Customer"] },
        email: "$customer.email",
        phone: "$customer.phone",
        joinedDate: "$customer.createdAt",
        lastLogin: "$customer.lastLogin",
        isActive: { $ifNull: ["$customer.isActive", true] },
        status: {
          $cond: [{ $eq: ["$customer.isActive", false] }, "inactive", "active"],
        },
        totalBookings: 1,
        deliveredBookings: 1,
        cancelledBookings: 1,
        totalSpent: { $round: ["$totalSpent", 2] },
        lastBookingAt: 1,
        avatar: {
          $concat: [
            "https://api.dicebear.com/7.x/avataaars/svg?seed=",
            { $ifNull: ["$customer.name", "Customer"] },
          ],
        },
      },
    },
    { $sort: { [sortField]: direction, id: 1 } },
  ];

  const [result] = await Parcel.aggregate([
    ...pipeline,
    {
      $facet: {
        totalCount: [{ $count: "count" }],
        items: [{ $skip: skip }, { $limit: limit }],
        statusCounts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        totals: [
          {
            $group: {
              _id: null,
              totalSpent: { $sum: "$totalSpent" },
              totalBookings: { $sum: "$totalBookings" },
            },
          },
        ],
      },
    },
  ]);

  const total = result?.totalCount?.[0]?.count ?? 0;
  const items = result?.items ?? [];
  const statusCounts = (result?.statusCounts ?? []).reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});
  const totals = result?.totals?.[0] || {};

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    stats: {
      totalPorterCustomers: total,
      active: statusCounts.active || 0,
      inactive: statusCounts.inactive || 0,
      totalBookings: totals.totalBookings || 0,
      totalRevenue: round2(totals.totalSpent || 0),
    },
  };
}

/** Flattens either booking shape into the one row the detail page renders. */
const toBookingRow = (doc, source) => ({
  id: String(doc._id),
  source,
  referenceId: doc.referenceId || null,
  status: doc.status,
  fare: round2(doc.fare),
  paymentMethod: doc.paymentMethod,
  paymentStatus: doc.paymentStatus,
  pickup: doc.pickupAddress?.fullAddress || "",
  drop: doc.dropAddress?.fullAddress || "",
  receiver: doc.receiver?.name || null,
  createdAt: doc.createdAt,
  deliveredAt: doc.deliveredAt || null,
  cancelledAt: doc.cancelledAt || null,
});

const RECENT_BOOKINGS_LIMIT = 25;

export async function getPorterCustomerByIdData(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const customerObjectId = new mongoose.Types.ObjectId(id);

  const [customer, statsAgg, recentPickup] = await Promise.all([
    Customer.findOne({ _id: id, role: "user" })
      .select("name email phone avatar isActive isVerified addresses createdAt lastLogin")
      .lean(),
    Parcel.aggregate([
      ...bookingUnionPipeline({ customerId: customerObjectId }),
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          deliveredBookings: { $sum: { $cond: [{ $eq: ["$status", DELIVERED] }, 1, 0] } },
          cancelledBookings: { $sum: { $cond: [{ $eq: ["$status", CANCELLED] }, 1, 0] } },
          totalSpent: { $sum: { $cond: [{ $eq: ["$status", DELIVERED] }, "$fare", 0] } },
          lastBookingAt: { $max: "$createdAt" },
          firstBookingAt: { $min: "$createdAt" },
        },
      },
    ]),
    Parcel.find(visibleParcels({ customerId: id }))
      .sort({ createdAt: -1 })
      .limit(RECENT_BOOKINGS_LIMIT)
      .select("status fare paymentMethod paymentStatus pickupAddress dropAddress createdAt")
      .lean(),
  ]);

  if (!customer) return null;

  const stats = statsAgg[0] || {};
  const deliveredBookings = stats.deliveredBookings || 0;
  const totalSpent = round2(stats.totalSpent || 0);

  const recentBookings = recentPickup
    .map((doc) => toBookingRow(doc, "pickup"))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, RECENT_BOOKINGS_LIMIT);

  return {
    id: String(customer._id),
    name: customer.name || "Unnamed Customer",
    email: customer.email || "",
    phone: customer.phone,
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(
      customer.name || customer.phone || "Customer",
    )}`,
    isActive: customer.isActive !== false,
    status: customer.isActive === false ? "inactive" : "active",
    isVerified: Boolean(customer.isVerified),
    joinedDate: customer.createdAt,
    lastLogin: customer.lastLogin || null,
    addresses: Array.isArray(customer.addresses) ? customer.addresses : [],
    totalBookings: stats.totalBookings || 0,
    deliveredBookings,
    cancelledBookings: stats.cancelledBookings || 0,
    totalSpent,
    avgOrderValue: deliveredBookings ? round2(totalSpent / deliveredBookings) : 0,
    lastBookingAt: stats.lastBookingAt || null,
    firstBookingAt: stats.firstBookingAt || null,
    recentBookings,
  };
}

export async function updatePorterCustomerStatusData(id, isActive) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const customer = await Customer.findOneAndUpdate(
    { _id: id, role: "user" },
    { $set: { isActive: Boolean(isActive) } },
    { new: true },
  )
    .select("name email phone isActive")
    .lean();

  if (!customer) return null;

  return {
    id: String(customer._id),
    name: customer.name,
    isActive: customer.isActive !== false,
    status: customer.isActive === false ? "inactive" : "active",
  };
}
