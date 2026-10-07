import Parcel from "../models/parcel.js";
import DeliveryZone from "../models/deliveryZone.js";
import Delivery from "../models/delivery.js";
import ParcelReview from "../models/parcelReview.js";
import CashDeposit from "../models/cashDeposit.js";
import CourierCompany from "../models/courierCompany.js";
import handleResponse from "../utils/helper.js";
import { visibleParcels } from "../services/bookingCheckoutService.js";
import { getRefundTotals } from "../services/porter/porterRefundService.js";
import {
  CASH_WITH_ADMIN,
  buildDeliveredMoneyGroup,
  splitParcelIds,
  computeRiderMoney,
  buildEarnings,
} from "../services/porter/porterEarningsService.js";

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
    // Payment filter: "cod" = cash on delivery, "online" = UPI/card through
    // the gateway (a COD booking the customer paid by QR at the door is
    // already UPI by then, so it counts as online), "wallet" = paid from the
    // customer's wallet. "all" is every method combined.
    const payment = ["cod", "online", "wallet"].includes(String(req.query?.payment || "").toLowerCase())
      ? String(req.query.payment).toLowerCase()
      : "all";
    const paymentFilter =
      payment === "cod"
        ? { paymentMethod: "COD" }
        : payment === "wallet"
          ? { paymentMethod: "WALLET" }
          : payment === "online"
            ? { paymentMethod: { $in: ["UPI", "CARD"] } }
            : {};

    const pickupWindow = visibleParcels({ ...window, ...paymentFilter });
    // Same window with no payment filter — feeds the All / COD / Online
    // totals, which must stay visible whichever tab is selected.
    const unfilteredWindow = visibleParcels(window);

    const dailyGroup = {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      // Booking volume counts every booking made that day, cancelled or not
      // — that's a real count of activity. Revenue does not: a cancelled or
      // still-in-progress booking's fare was never actually earned, so only
      // DELIVERED rows contribute to it. Matches the window's main revenue
      // card below, which was already DELIVERED-only — this trend line had
      // drifted from that and was overstating revenue by whatever cancelled
      // and in-flight bookings added up to.
      count: { $sum: 1 },
      revenue: { $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, "$fare", 0] } },
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
      courierCompanyAgg,
      paymentSplitAgg,
      topAreaAgg,
      busyRiders,
      todayParcels,
      riderParcelAgg,
      riderRejectAgg,
      riderDocs,
      refundTotals,
    ] = await Promise.all([
      Parcel.aggregate([
        { $match: pickupWindow },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      // Delivered bookings, with every line item split into cash that has
      // reached admin vs cash still with a rider (see porterEarningsService).
      Parcel.aggregate([
        { $match: { ...pickupWindow, status: "DELIVERED" } },
        buildDeliveredMoneyGroup(),
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

      // Per courier company: `bookings` is every booking placed with them in
      // the window, any status — real activity. `charge` is only what they
      // were actually paid for, i.e. DELIVERED bookings' courierCharge (the
      // pass-through fee that company billed for the city-to-city leg, not
      // platform revenue) — same DELIVERED-only rule as the revenue card
      // above, for the same reason: a cancelled booking's charge was never
      // actually owed to that company.
      Parcel.aggregate([
        { $match: { ...pickupWindow, courierCompanyId: { $ne: null } } },
        {
          $group: {
            _id: "$courierCompanyId",
            bookings: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] } },
            charge: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "DELIVERED"] },
                  { $ifNull: ["$fareBreakdown.courierCharge", 0] },
                  0,
                ],
              },
            },
          },
        },
        { $sort: { charge: -1 } },
      ]),

      // COD vs online. `amount` is what actually reached admin.
      Parcel.aggregate([
        { $match: unfilteredWindow },
        {
          $group: {
            _id: {
              $switch: {
                branches: [
                  { case: { $eq: ["$paymentMethod", "COD"] }, then: "cod" },
                  { case: { $eq: ["$paymentMethod", "WALLET"] }, then: "wallet" },
                ],
                default: "online",
              },
            },
            bookings: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] } },
            // Delivered fare whose cash has reached admin vs is still with a rider.
            amount: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$status", "DELIVERED"] }, CASH_WITH_ADMIN] },
                  "$fare",
                  0,
                ],
              },
            },
            withRiders: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$status", "DELIVERED"] }, { $not: [CASH_WITH_ADMIN] }] },
                  "$fare",
                  0,
                ],
              },
            },
          },
        },
      ]),

      Parcel.aggregate([
        { $match: { ...pickupWindow, zoneId: { $ne: null } } },
        { $group: { _id: "$zoneId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),

      // A rider is busy while they hold a parcel that isn't finished.
      Parcel.distinct("deliveryPartnerId", {
        deliveryPartnerId: { $ne: null },
        status: { $nin: PICKUP_TERMINAL },
      }),
      Parcel.countDocuments(
        visibleParcels({
          ...paymentFilter,
          createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        }),
      ),

      // Per-rider accepted / delivered in the window.
      Parcel.aggregate([
        { $match: { ...pickupWindow, deliveryPartnerId: { $ne: null } } },
        {
          $group: {
            _id: "$deliveryPartnerId",
            accepted: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] } },
          },
        },
      ]),
      // Explicit rejects only (skippedBy); offers that merely timed out
      // are not rejections.
      Parcel.aggregate([
        { $match: { ...pickupWindow, "skippedBy.0": { $exists: true } } },
        { $unwind: "$skippedBy" },
        { $group: { _id: "$skippedBy", rejected: { $sum: 1 } } },
      ]),
      Delivery.find({ isParcelService: true }).select("name phone isOnline").lean(),

      // Cancelled online bookings in this window: refunded / pending / failed.
      getRefundTotals(pickupWindow),
    ]);

    const pickupStatusCounts = toStatusCounts(pickupByStatus);
    const pickupTotals = pickupMoney[0] || {};

    const pickupTotal = countTotal(pickupByStatus);

    const inFlight = (counts, terminal) =>
      Object.entries(counts)
        .filter(([status]) => !terminal.includes(status))
        .reduce((sum, [, count]) => sum + count, 0);

    // Revenue = everything billed on delivered bookings. Admin earning is
    // stricter: only bookings whose cash has actually reached admin.
    const revenue = round2((pickupTotals.r_fare || 0) + (pickupTotals.p_fare || 0));

    const { realizedIds, pendingIds } = splitParcelIds(pickupTotals);
    const riderMoney = await computeRiderMoney(realizedIds, pendingIds);
    const earnings = buildEarnings(pickupTotals, riderMoney);
    const adminEarning = earnings.realized.earning;

    // Booking status donut: completed / ongoing / pending / cancelled.
    const statusOverview = {
      completed: pickupStatusCounts.DELIVERED || 0,
      cancelled: pickupStatusCounts.CANCELLED || 0,
      pending: (pickupStatusCounts.REQUESTED || 0) + (pickupStatusCounts.SEARCHING || 0),
    };
    statusOverview.ongoing = Math.max(
      pickupTotal - statusOverview.completed - statusOverview.cancelled - statusOverview.pending,
      0,
    );

    const paymentSummary = { all: { bookings: 0, delivered: 0, amount: 0, withRiders: 0 } };
    for (const key of ["cod", "online", "wallet"]) {
      const row = paymentSplitAgg.find((r) => r._id === key) || {};
      paymentSummary[key] = {
        bookings: row.bookings || 0,
        delivered: row.delivered || 0,
        amount: round2(row.amount),
        withRiders: round2(row.withRiders),
      };
      paymentSummary.all.withRiders = round2(
        paymentSummary.all.withRiders + paymentSummary[key].withRiders,
      );
      paymentSummary.all.bookings += paymentSummary[key].bookings;
      paymentSummary.all.delivered += paymentSummary[key].delivered;
      paymentSummary.all.amount = round2(paymentSummary.all.amount + paymentSummary[key].amount);
    }

    const zoneDocs = topAreaAgg.length
      ? await DeliveryZone.find({ _id: { $in: topAreaAgg.map((r) => r._id) } })
          .select("name city")
          .lean()
      : [];
    const zoneById = new Map(zoneDocs.map((z) => [String(z._id), z]));
    const topAreas = topAreaAgg.map((row) => ({
      zoneId: String(row._id),
      name: zoneById.get(String(row._id))?.name || "Unknown zone",
      city: zoneById.get(String(row._id))?.city || "",
      count: row.count,
    }));

    const busySet = new Set(busyRiders.map(String));
    const fleetBusy = riderDocs.filter((r) => r.isOnline && busySet.has(String(r._id))).length;

    const parcelStatsByRider = new Map(riderParcelAgg.map((r) => [String(r._id), r]));
    const rejectsByRider = new Map(riderRejectAgg.map((r) => [String(r._id), r.rejected]));
    const drivers = riderDocs
      .map((rider) => {
        const stats = parcelStatsByRider.get(String(rider._id)) || {};
        return {
          id: String(rider._id),
          name: rider.name,
          phone: rider.phone,
          isOnline: !!rider.isOnline,
          isBusy: busySet.has(String(rider._id)),
          delivered: stats.delivered || 0,
          accepted: stats.accepted || 0,
          rejected: rejectsByRider.get(String(rider._id)) || 0,
        };
      })
      .sort((a, b) => b.delivered - a.delivered || b.accepted - a.accepted);

    const recent = recentPickup
      .map((doc) => toRecentRow(doc, "pickup"))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8);

    const courierCompanyNames = courierCompanyAgg.length
      ? await CourierCompany.find({ _id: { $in: courierCompanyAgg.map((row) => row._id) } })
          .select("name")
          .lean()
      : [];
    const courierCompanyNameById = new Map(
      courierCompanyNames.map((c) => [String(c._id), c.name]),
    );
    const courierCompanies = courierCompanyAgg.map((row) => ({
      id: String(row._id),
      name: courierCompanyNameById.get(String(row._id)) || "Unknown company",
      bookings: row.bookings,
      delivered: row.delivered,
      charge: round2(row.charge),
    }));

    return handleResponse(res, 200, "Courier dashboard", {
      range: { days, from, to: new Date() },
      overview: {
        totalParcels: pickupTotal,
        activeParcels: inFlight(pickupStatusCounts, PICKUP_TERMINAL),
        todayParcels,
        deliveredParcels: pickupTotals.delivered || 0,
        cancelledParcels: pickupStatusCounts.CANCELLED || 0,
        revenue: round2(revenue),
        // What riders have actually been PAID (settled withdrawals). What they
        // have earned but not yet withdrawn is riderOwed.
        riderPayout: riderMoney.paid,
        riderEarned: riderMoney.earned,
        riderOwed: riderMoney.owed,
        // Delivered COD whose cash a rider still holds — not earning yet.
        pendingEarning: earnings.pending.earning,
        cashWithRiders: earnings.cashWithRiders,
        // Kept as "margin" for any other consumer of this field; it's the
        // same number as adminEarning below, just the older name.
        margin: adminEarning,
        adminEarning,
        distanceKm: round1(pickupTotals.distanceKm || 0),
        zones: { total: zoneTotal, active: zoneActive },
        fleet: {
          total: riderTotal,
          online: riderOnline,
          busy: fleetBusy,
          offline: Math.max(riderTotal - riderOnline, 0),
          verified: riderVerified,
        },
        rating: {
          average: round1(ratingAgg[0]?.average || 0),
          count: ratingAgg[0]?.count || 0,
        },
      },
      breakdown: {
        pickup: {
          total: pickupTotal,
          delivered: pickupTotals.delivered || 0,
          revenue,
          statusCounts: pickupStatusCounts,
        },
      },
      // Every component behind adminEarning, for the dashboard card to show
      // as line items rather than a single opaque number.
      marginBreakdown: {
        deliveryCharge: earnings.realized.delivery,
        weightCharge: earnings.realized.weight,
        expressCharge: earnings.realized.express,
        courierCompanyCharge: earnings.realized.courier,
        gstCollected: earnings.realized.gst,
        riderEarning: earnings.realized.riderEarning,
        adminEarning,
        // Delivered but the cash is still with a rider, so not counted yet.
        pending: {
          cashWithRiders: earnings.cashWithRiders,
          charges: earnings.pending.charges,
          riderEarning: earnings.pending.riderEarning,
          earning: earnings.pending.earning,
        },
        received: earnings.received,
      },
      courierCompanies,
      statusOverview,
      topAreas,
      paymentFilter: payment,
      paymentSummary,
      refunds: refundTotals,
      drivers,
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
