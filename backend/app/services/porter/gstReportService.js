import Parcel from "../../models/parcel.js";
import ParcelConfig from "../../models/parcelConfig.js";
import { normalizeGstConfig } from "../../utils/gst.js";

/**
 * What GST the porter desk has charged, and how much of it has actually been
 * collected.
 *
 * Two numbers that are commonly confused and must not be:
 *
 *   CHARGED   — tax on every booking that was actually billed, whether or not
 *               the money has arrived yet. COD is billed at booking, since the
 *               rider will collect regardless. An online payment isn't billed
 *               until the gateway confirms it PAID — a checkout the customer
 *               opened but never paid for (and never cancelled either) has no
 *               real tax liability, so it's excluded from this figure.
 *   COLLECTED — tax on bookings whose money is genuinely with the platform:
 *               an online payment that captured, or COD cash that a rider has
 *               deposited AND an admin has approved.
 *
 * A COD booking sitting in a rider's pocket has charged GST that nobody has
 * collected. Reporting the two as one figure is how an operation ends up
 * remitting tax on money it has not been given.
 *
 * Read off the BOOKINGS rather than the payment ledger, deliberately: COD has
 * no gateway payment at all, and a report that only counted gateway payments
 * would silently omit whichever share of the business pays in cash.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Bookings whose money is genuinely in hand. */
const SETTLED_MATCH = {
  $or: [
    // Paid through the gateway.
    { paymentMethod: { $ne: "COD" }, paymentStatus: "PAID" },
    // COD that reached the admin — the rider deposited and it was approved.
    { paymentMethod: "COD", "codCollection.status": "REMITTED_TO_ADMIN" },
    { paymentMethod: "COD", "codSettlement.status": "REMITTED_TO_ADMIN" },
  ],
};

/**
 * Bookings that were actually billed to the customer.
 *
 * COD is billed the moment it's booked — the rider will collect cash on
 * delivery regardless of whether the gateway saw a rupee. An online payment
 * (UPI/card/wallet) is different: until the gateway confirms it PAID, no
 * money has actually been asked of the customer. A booking where the
 * customer opened checkout, never completed the payment, and never
 * cancelled either has no real GST liability — counting it as "charged"
 * invents tax on a sale that never happened.
 */
const BILLED_MATCH = {
  $or: [
    { paymentMethod: "COD" },
    { paymentMethod: { $ne: "COD" }, paymentStatus: "PAID" },
  ],
};

/**
 * The GST fields, summed.
 *
 * `$ifNull` throughout because bookings made before GST existed have none of
 * these fields, and those bookings genuinely contributed zero tax — treating
 * a missing field as anything else would invent revenue.
 */
const TAX_SUMS = {
  bookings: { $sum: 1 },
  /**
   * What the customer was actually billed, so this reconciles with the
   * taxable + tax columns beside it and with the revenue on the dashboard.
   * `fare` is the rate-card price BEFORE any coupon; summing it here made a
   * discounted booking report more gross than the customer ever paid.
   * Pre-coupon bookings have `payableFare` equal to `fare`, and rows written
   * before the field existed fall back to it.
   */
  gross: {
    $sum: {
      $cond: [
        { $gt: [{ $ifNull: ["$payableFare", 0] }, 0] },
        "$payableFare",
        { $ifNull: ["$fare", 0] },
      ],
    },
  },
  discount: { $sum: { $ifNull: ["$discountAmount", 0] } },
  taxable: {
    $sum: {
      $ifNull: [
        "$fareBreakdown.taxableAmount",
        // Pre-GST bookings: the whole fare was the taxable value, because
        // no tax was added to it.
        { $ifNull: ["$fare", 0] },
      ],
    },
  },
  gst: { $sum: { $ifNull: ["$fareBreakdown.gstAmount", 0] } },
  cgst: { $sum: { $ifNull: ["$fareBreakdown.cgst", 0] } },
  sgst: { $sum: { $ifNull: ["$fareBreakdown.sgst", 0] } },
};

const emptyBucket = () => ({
  bookings: 0,
  gross: 0,
  discount: 0,
  taxable: 0,
  gst: 0,
  cgst: 0,
  sgst: 0,
});

function shapeBucket(row) {
  if (!row) return emptyBucket();
  return {
    bookings: row.bookings || 0,
    gross: round2(row.gross),
    discount: round2(row.discount),
    taxable: round2(row.taxable),
    gst: round2(row.gst),
    cgst: round2(row.cgst),
    sgst: round2(row.sgst),
  };
}

function addBuckets(a, b) {
  return {
    bookings: a.bookings + b.bookings,
    gross: round2(a.gross + b.gross),
    discount: round2(a.discount + b.discount),
    taxable: round2(a.taxable + b.taxable),
    gst: round2(a.gst + b.gst),
    cgst: round2(a.cgst + b.cgst),
    sgst: round2(a.sgst + b.sgst),
  };
}

function dateWindow({ from, to }) {
  const match = {};
  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) match.$gte = start;
  }
  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      // Inclusive of the whole closing day — an admin picking "to: 31 Mar"
      // means the end of the 31st, not its first millisecond.
      end.setHours(23, 59, 59, 999);
      match.$lte = end;
    }
  }
  return Object.keys(match).length ? { createdAt: match } : {};
}

/** Charged vs collected for one collection. */
async function summariseCollection(Model, window) {
  const [chargedRows, collectedRows] = await Promise.all([
    Model.aggregate([
      { $match: { status: { $ne: "CANCELLED" }, ...window, ...BILLED_MATCH } },
      { $group: { _id: null, ...TAX_SUMS } },
    ]),
    Model.aggregate([
      { $match: { status: { $ne: "CANCELLED" }, ...window, ...SETTLED_MATCH } },
      { $group: { _id: null, ...TAX_SUMS } },
    ]),
  ]);

  const charged = shapeBucket(chargedRows[0]);
  const collected = shapeBucket(collectedRows[0]);

  return {
    charged,
    collected,
    /** Charged but not yet in hand — mostly COD still with riders. */
    outstanding: {
      bookings: charged.bookings - collected.bookings,
      gross: round2(charged.gross - collected.gross),
      discount: round2(charged.discount - collected.discount),
      taxable: round2(charged.taxable - collected.taxable),
      gst: round2(charged.gst - collected.gst),
      cgst: round2(charged.cgst - collected.cgst),
      sgst: round2(charged.sgst - collected.sgst),
    },
  };
}

/**
 * A month-by-month series for the chart, on COLLECTED tax.
 *
 * Collected rather than charged because a GST return is filed on what was
 * received, and a chart of charged tax would show the operation owing more
 * than it holds every time COD volume rises.
 */
async function monthlySeries(Model, window, label) {
  const rows = await Model.aggregate([
    { $match: { status: { $ne: "CANCELLED" }, ...window, ...SETTLED_MATCH } },
    {
      $group: {
        _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
        gst: { $sum: { $ifNull: ["$fareBreakdown.gstAmount", 0] } },
        taxable: {
          $sum: { $ifNull: ["$fareBreakdown.taxableAmount", { $ifNull: ["$fare", 0] }] },
        },
        bookings: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  return rows.map((row) => ({
    period: `${row._id.year}-${String(row._id.month).padStart(2, "0")}`,
    source: label,
    gst: round2(row.gst),
    taxable: round2(row.taxable),
    bookings: row.bookings,
  }));
}

/**
 * The whole GST picture for the admin screen: local, outstation, and the two
 * combined, plus the rates currently in force.
 */
export async function getPorterGstReport({ from = null, to = null } = {}) {
  const window = dateWindow({ from, to });

  const [outstation, outstationSeries, parcelConfig] = await Promise.all([
    summariseCollection(Parcel, window),
    monthlySeries(Parcel, window, "outstation"),
    ParcelConfig.getOrCreate(),
  ]);

  const combined = {
    charged: outstation.charged,
    collected: outstation.collected,
    outstanding: outstation.outstanding,
  };

  const byPeriod = new Map();
  outstationSeries.forEach((row) => {
    const entry = byPeriod.get(row.period) || {
      period: row.period,
      localGst: 0,
      outstationGst: 0,
      totalGst: 0,
      bookings: 0,
    };
    entry.outstationGst = row.gst;
    entry.totalGst = round2(entry.localGst + entry.outstationGst);
    entry.bookings += row.bookings;
    byPeriod.set(row.period, entry);
  });

  return {
    window: { from, to },
    rates: {
      outstation: normalizeGstConfig(parcelConfig.gst),
    },
    outstation,
    combined,
    series: [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)),
  };
}

/**
 * Line-by-line GST for a window — what an accountant exports.
 *
 * Paginated, and it returns the fields a GSTR-1 style summary needs rather
 * than whole booking documents: the invoice number, the date, the taxable
 * value, the rate, and the split.
 */
export async function getPorterGstLedger({
  from = null,
  to = null,
  source = "all",
  settledOnly = true,
  page = 1,
  limit = 50,
} = {}) {
  const window = dateWindow({ from, to });
  const match = {
    status: { $ne: "CANCELLED" },
    ...window,
    ...(settledOnly ? SETTLED_MATCH : BILLED_MATCH),
  };

  const skip = (Math.max(1, page) - 1) * limit;
  const wantOutstation = source === "all" || source === "outstation";

  const project = {
    fare: 1,
    payableFare: 1,
    discountAmount: 1,
    createdAt: 1,
    paymentMethod: 1,
    paymentStatus: 1,
    "fareBreakdown.taxableAmount": 1,
    "fareBreakdown.gstPercent": 1,
    "fareBreakdown.gstAmount": 1,
    "fareBreakdown.cgst": 1,
    "fareBreakdown.sgst": 1,
    "fareBreakdown.gstin": 1,
  };

  const [outstationRows, outstationCount] = await Promise.all([
    wantOutstation
      ? Parcel.find(match, { ...project, customerId: 1, destinationCity: 1 })
          .sort({ createdAt: -1 })
          .limit(skip + limit)
          .lean()
      : [],
    wantOutstation ? Parcel.countDocuments(match) : 0,
  ]);

  const rows = [
    ...outstationRows.map((row) => ({
      source: "outstation",
      id: String(row._id),
      invoiceNo: `PCL-${String(row._id).slice(-6).toUpperCase()}`,
      date: row.createdAt,
      paymentMethod: row.paymentMethod,
      paymentStatus: row.paymentStatus,
      destinationCity: row.destinationCity || "",
      total: round2(row.payableFare > 0 ? row.payableFare : row.fare),
      discount: round2(row.discountAmount),
      taxable: round2(row.fareBreakdown?.taxableAmount ?? row.fare),
      gstPercent: Number(row.fareBreakdown?.gstPercent) || 0,
      gst: round2(row.fareBreakdown?.gstAmount),
      cgst: round2(row.fareBreakdown?.cgst),
      sgst: round2(row.fareBreakdown?.sgst),
      gstin: row.fareBreakdown?.gstin || "",
    })),
  ]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(skip, skip + limit);

  const total = outstationCount;

  return {
    items: rows,
    page: Math.max(1, page),
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  };
}
