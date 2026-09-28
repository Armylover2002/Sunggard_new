import Parcel from "../models/parcel.js";
import DeliveryZone from "../models/deliveryZone.js";
import Delivery from "../models/delivery.js";
import ParcelReview from "../models/parcelReview.js";
import CashDeposit from "../models/cashDeposit.js";
import handleResponse from "../utils/helper.js";
import { visibleParcels } from "../services/bookingCheckoutService.js";

/**
 * One console for the porter side of the desk.
 *
 * Reports on the outstation (pickup-service) parcel flow in models/parcel.js.
 */

/** A parcel is finished, one way or another. Everything else is in flight. */
const PICKUP_TERMINAL = ["DELIVERED", "CANCELLED"];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** Folds a `$group`-by-status aggregation into a plain lookup object. */
const toStatusCounts = (rows) =>
  rows.reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});

const countTotal = (rows) => rows.reduce((sum, row) => sum + row.count, 0);

/**
 * Daily buckets covering the whole window, so a quiet day plots as zero
 * rather than vanishing and pulling the next day's point left.
 */
const buildTrend = (from, days, pickupRows) => {
  const pickupByDay = new Map(pickupRows.map((r) => [r._id, r]));

  return Array.from({ length: days }, (_, i) => {
    const day = new Date(from);
    day.setUTCDate(day.getUTCDate() + i);
    const key = day.toISOString().slice(0, 10);

    const pickup = pickupByDay.get(key);
    const pickupCount = pickup?.count || 0;

    return {
      date: key,
      pickup: pickupCount,
      city: 0,
      total: pickupCount,
      revenue: round2(pickup?.revenue || 0),
    };
  });
};

/** Flattens the parcel shape into the one row the dashboard table renders. */
const toRecentRow = (doc, source) => ({
  id: String(doc._id),
  source,
  status: doc.status,
  fare: round2(doc.fare),
  customer: doc.customerId?.name || "Customer",
  rider: doc.deliveryPartnerId?.name || null,
  createdAt: doc.createdAt,
});

export const adminGetPorterDashboard = async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query?.days) || 14, 1), 90);

    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    const window = { createdAt: { $gte: from } };

    /**
     * The parcel product writes a booking row before the customer pays, so
     * the gateway has something to attach an order id to. Counting those
     * made the console report bookings nobody made and revenue nobody owed.
     */
    const pickupWindow = visibleParcels(window);

    const dailyGroup = {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      count: { $sum: 1 },
      revenue: { $sum: "$fare" },
    };

    const [
      pickupByStatus,
      pickupMoney,
      pickupDaily,
      zoneTotal,
      zoneActive,
      pickupUnassigned,
      pickupRefundRequests,
      riderTotal,
      riderOnline,
      riderVerified,
      ratingAgg,
      cashDepositsPending,
      recentPickup,
    ] = await Promise.all([
      Parcel.aggregate([
        { $match: pickupWindow },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Parcel.aggregate([
        { $match: { ...pickupWindow, status: "DELIVERED" } },
        {
          $group: {
            _id: null,
            delivered: { $sum: 1 },
            revenue: { $sum: "$fare" },
            distanceKm: { $sum: "$distance" },
          },
        },
      ]),
      Parcel.aggregate([{ $match: pickupWindow }, { $group: dailyGroup }]),

      DeliveryZone.countDocuments({}),
      DeliveryZone.countDocuments({ isActive: true }),

      Parcel.countDocuments({
        ...pickupWindow,
        deliveryPartnerId: null,
        status: { $in: ["REQUESTED", "SEARCHING"] },
      }),
      Parcel.countDocuments({
        ...pickupWindow,
        "lateRefundRequest.status": "requested",
      }),

      // Fleet snapshot is a point-in-time headcount, not windowed to `days` —
      // "how many porters do we have right now", not "how many were created".
      Delivery.countDocuments({ isParcelService: true }),
      Delivery.countDocuments({ isParcelService: true, isOnline: true }),
      Delivery.countDocuments({ isParcelService: true, isVerified: true }),
      ParcelReview.aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
      CashDeposit.countDocuments({ status: "PENDING" }),

      Parcel.find(pickupWindow)
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("customerId", "name")
        .populate("deliveryPartnerId", "name")
        .select("status fare customerId deliveryPartnerId createdAt")
        .lean(),
    ]);

    const pickupStatusCounts = toStatusCounts(pickupByStatus);
    const pickupTotals = pickupMoney[0] || {};

    const pickupTotal = countTotal(pickupByStatus);

    const inFlight = (counts, terminal) =>
      Object.entries(counts)
        .filter(([status]) => !terminal.includes(status))
        .reduce((sum, [, count]) => sum + count, 0);

    const revenue = pickupTotals.revenue || 0;
    // The pickup flow settles riders outside the parcel document, so there
    // is no stored rider share to report here.
    const riderPayout = 0;

    const recent = recentPickup
      .map((doc) => toRecentRow(doc, "pickup"))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8);

    return handleResponse(res, 200, "Porter dashboard", {
      range: { days, from, to: new Date() },
      overview: {
        totalParcels: pickupTotal,
        activeParcels: inFlight(pickupStatusCounts, PICKUP_TERMINAL),
        deliveredParcels: pickupTotals.delivered || 0,
        cancelledParcels: pickupStatusCounts.CANCELLED || 0,
        revenue: round2(revenue),
        riderPayout: round2(riderPayout),
        margin: round2(revenue - riderPayout),
        distanceKm: round1(pickupTotals.distanceKm || 0),
        zones: { total: zoneTotal, active: zoneActive },
        fleet: { total: riderTotal, online: riderOnline, verified: riderVerified },
        rating: {
          average: round1(ratingAgg[0]?.average || 0),
          count: ratingAgg[0]?.count || 0,
        },
      },
      breakdown: {
        pickup: {
          total: pickupTotal,
          delivered: pickupTotals.delivered || 0,
          revenue: round2(pickupTotals.revenue),
          statusCounts: pickupStatusCounts,
        },
      },
      needsAttention: {
        unassigned: pickupUnassigned,
        failed: 0,
        withheldPayouts: 0,
        refundRequests: pickupRefundRequests,
        cashDepositsPending,
      },
      trend: buildTrend(from, days, pickupDaily),
      recent,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
