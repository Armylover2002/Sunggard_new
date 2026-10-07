import Transaction from "../models/transaction.js";
import Parcel from "../models/parcel.js";
import Delivery from "../models/delivery.js";
import handleResponse from "../utils/helper.js";
import { getRefundTotals } from "../services/porter/porterRefundService.js";
import {
  buildDeliveredMoneyGroup,
  splitParcelIds,
  computeRiderMoney,
  buildEarnings,
} from "../services/porter/porterEarningsService.js";

/**
 * What the porter desk has paid its riders.
 *
 * The admin Money Requests screen lists rider *withdrawals*, and a withdrawal
 * cannot be attributed to porter: a rider's balance pools what they earned on
 * grocery orders and on parcels, and they draw against the pool. Splitting
 * that after the fact would be invention.
 *
 * What is genuinely porter-only is the earning side. Every parcel settlement
 * stamps `meta.kind` on the ledger row it writes, while a grocery earning
 * carries an `order` reference and no kind — so these two populations never
 * overlap. This endpoint reports the porter half of that ledger, which is the
 * honest answer to "what does porter owe, and what has it paid".
 */

/** Ledger stamps written by the parcel settlement service. */
const PORTER_EARNING_KINDS = ["parcel"];

/** Human labels for those stamps, so the UI never renders a raw enum. */
const KIND_LABELS = {
  parcel: "Courier",
};

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const adminGetPorterRiderPayouts = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
    const skip = (page - 1) * limit;

    const kind = String(req.query?.kind || "").trim();
    const match = {
      userModel: "Delivery",
      type: "Delivery Earning",
      "meta.kind": PORTER_EARNING_KINDS.includes(kind) ? kind : { $in: PORTER_EARNING_KINDS },
    };

    const [rows, total, byKind, riderCount, earnedByRiderAgg] = await Promise.all([
      Transaction.find(match)
        .populate("user", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(match),
      Transaction.aggregate([
        { $match: match },
        { $group: { _id: "$meta.kind", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Transaction.distinct("user", match),
      Transaction.aggregate([
        { $match: match },
        { $group: { _id: "$user", amount: { $sum: "$amount" } } },
      ]),
    ]);

    // An earning row is "Settled" the moment it is credited to the rider's
    // wallet — that is NOT the rider being paid. Paid means the admin has
    // settled a withdrawal. Withdrawals draw on one pool, so they are
    // applied oldest-earning-first: a row is Paid once the rider's settled
    // withdrawals have covered everything up to and including it.
    const withdrawnAgg = earnedByRiderAgg.length
      ? await Transaction.aggregate([
          {
            $match: {
              userModel: "Delivery",
              type: "Withdrawal",
              status: "Settled",
              user: { $in: earnedByRiderAgg.map((r) => r._id) },
            },
          },
          { $group: { _id: "$user", amount: { $sum: { $abs: "$amount" } } } },
        ])
      : [];
    const withdrawnByRider = new Map(withdrawnAgg.map((r) => [String(r._id), r.amount || 0]));
    const totalEarned = round2(earnedByRiderAgg.reduce((sum, r) => sum + (r.amount || 0), 0));
    const totalPaid = round2(
      earnedByRiderAgg.reduce(
        (sum, r) => sum + Math.min(r.amount || 0, withdrawnByRider.get(String(r._id)) || 0),
        0,
      ),
    );

    // Cumulative earning up to each page row, per rider, oldest first.
    const pageRiderIds = [...new Set(rows.map((r) => String(r.user?._id || r.user)))];
    const priorRows = pageRiderIds.length
      ? await Transaction.find({ ...match, user: { $in: pageRiderIds } })
          .select("user amount createdAt")
          .sort({ createdAt: 1, _id: 1 })
          .lean()
      : [];
    const cumulativeById = new Map();
    const running = new Map();
    for (const row of priorRows) {
      const key = String(row.user);
      const next = round2((running.get(key) || 0) + (row.amount || 0));
      running.set(key, next);
      cumulativeById.set(String(row._id), { cumulative: next, amount: row.amount || 0 });
    }
    const payoutStatusFor = (row) => {
      const entry = cumulativeById.get(String(row._id));
      if (!entry) return "In wallet";
      const withdrawn = withdrawnByRider.get(String(row.user?._id || row.user)) || 0;
      if (withdrawn + 0.001 >= entry.cumulative) return "Paid";
      if (withdrawn > entry.cumulative - entry.amount + 0.001) return "Partly paid";
      return "In wallet";
    };

    const modules = byKind.map((row) => ({
      kind: row._id,
      label: KIND_LABELS[row._id] || row._id,
      amount: round2(row.amount),
      count: row.count,
    }));

    return handleResponse(res, 200, "Courier rider payouts", {
      summary: {
        // Earned = credited to rider wallets. Paid = admin has settled the
        // rider's withdrawal. Owed = earned but still sitting in a wallet.
        totalEarned,
        totalPaid,
        totalOwed: round2(Math.max(0, totalEarned - totalPaid)),
        entries: total,
        riders: riderCount.length,
      },
      modules,
      items: rows.map((row) => ({
        id: String(row._id),
        rider: row.user?.name || "Rider",
        riderPhone: row.user?.phone || "",
        amount: round2(row.amount),
        kind: row.meta?.kind || "",
        kindLabel: KIND_LABELS[row.meta?.kind] || row.meta?.kind || "",
        parcelRef: row.meta?.referenceId || row.meta?.parcelId || "",
        distanceKm: row.meta?.distanceKm ?? null,
        paymentMethod: row.meta?.paymentMethod || "",
        status: row.status,
        payoutStatus: payoutStatusFor(row),
        reference: row.reference,
        date: row.date || row.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Every rider who has ever earned from a porter job. */
async function getPorterRiderIds() {
  return Transaction.distinct("user", {
    userModel: "Delivery",
    type: "Delivery Earning",
    "meta.kind": { $in: PORTER_EARNING_KINDS },
  });
}

/**
 * Porter Wallet — the platform-vs-rider money picture for the porter desk.
 *
 * Revenue and rider earning are genuinely porter-only: revenue sums delivered
 * parcel fares, and earning sums the `meta.kind`-stamped rows the settlement
 * services write (see PORTER_EARNING_KINDS above). Admin earning is simply
 * their difference — the platform's margin on porter jobs.
 *
 * Wallet balance and withdrawals are NOT porter-only, and this endpoint does
 * not pretend otherwise: a rider's payable balance pools every job they've
 * done (grocery orders and parcels alike), and a withdrawal draws against
 * that single pool the same way `deliveryEarningsService.computeDeliveryEarnings`
 * does for the rider's own earnings screen. What's reported here is that
 * same balance, for the subset of riders who do porter work — labelled as
 * "all services" everywhere the frontend shows it, not invented as a
 * porter-only figure that doesn't exist.
 */
export const adminGetPorterWalletOverview = async (req, res) => {
  try {
    const riderIds = await getPorterRiderIds();

    // All / COD / online / wallet. "online" is UPI or card via the gateway;
    // "wallet" is paid from the customer's wallet.
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

    const [pickupMoney, riderAgg, riderDocs, refundTotals] = await Promise.all([
      // Delivered bookings split into cash that has reached admin vs cash a
      // rider is still holding (see porterEarningsService).
      Parcel.aggregate([
        { $match: { status: "DELIVERED", ...paymentFilter } },
        buildDeliveredMoneyGroup(),
      ]),
      riderIds.length
        ? Transaction.aggregate([
            { $match: { user: { $in: riderIds }, userModel: "Delivery" } },
            {
              $group: {
                _id: "$user",
                totalEarned: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "Settled"] },
                          { $in: ["$type", ["Delivery Earning", "Incentive", "Bonus"]] },
                        ],
                      },
                      "$amount",
                      0,
                    ],
                  },
                },
                porterEarned: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$type", "Delivery Earning"] },
                          { $in: ["$meta.kind", PORTER_EARNING_KINDS] },
                        ],
                      },
                      "$amount",
                      0,
                    ],
                  },
                },
                withdrawnSettled: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$type", "Withdrawal"] }, { $eq: ["$status", "Settled"] }] },
                      { $abs: "$amount" },
                      0,
                    ],
                  },
                },
                pendingWithdrawal: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$type", "Withdrawal"] },
                          { $in: ["$status", ["Pending", "Processing"]] },
                        ],
                      },
                      { $abs: "$amount" },
                      0,
                    ],
                  },
                },
              },
            },
          ])
        : [],
      riderIds.length
        ? Delivery.find({ _id: { $in: riderIds } })
            .select("name phone vehicleType isOnline")
            .lean()
        : [],
      // Cancelled online bookings: refunded / pending / failed.
      getRefundTotals(paymentFilter),
    ]);

    const riderInfoMap = new Map(riderDocs.map((r) => [String(r._id), r]));

    const riderRows = riderAgg
      .map((row) => {
        const info = riderInfoMap.get(String(row._id)) || {};
        const walletBalance = round2(
          Math.max(0, (row.totalEarned || 0) - (row.withdrawnSettled || 0) - (row.pendingWithdrawal || 0)),
        );
        return {
          id: String(row._id),
          name: info.name || "Rider",
          phone: info.phone || "",
          vehicleType: info.vehicleType || "",
          isOnline: Boolean(info.isOnline),
          porterEarned: round2(row.porterEarned || 0),
          walletBalance,
          pendingWithdrawal: round2(row.pendingWithdrawal || 0),
        };
      })
      .sort((a, b) => b.porterEarned - a.porterEarned);

    const moneyTotals = pickupMoney[0] || {};
    const { realizedIds, pendingIds } = splitParcelIds(moneyTotals);
    const riderMoney = await computeRiderMoney(realizedIds, pendingIds);
    const earnings = buildEarnings(moneyTotals, riderMoney);
    // Revenue here is cash that has actually reached admin. Delivered COD
    // still in a rider's hands is reported separately, not as revenue.
    const revenue = earnings.realized.billed;
    const adminEarningTotal = earnings.realized.earning;
    const riderEarningTotal = riderMoney.earned;
    const walletBalanceTotal = round2(riderRows.reduce((sum, r) => sum + r.walletBalance, 0));
    const pendingWithdrawalTotal = round2(riderRows.reduce((sum, r) => sum + r.pendingWithdrawal, 0));
    const paidOutTotal = round2(riderAgg.reduce((sum, r) => sum + (r.withdrawnSettled || 0), 0));

    return handleResponse(res, 200, "Courier wallet overview", {
      paymentFilter: payment,
      refunds: refundTotals,
      revenue: {
        total: revenue,
        pickup: revenue,
        // Where that cash came from, and what is still out with riders.
        online: earnings.received.online,
        wallet: earnings.received.wallet,
        cod: earnings.received.cod,
        codWithRiders: earnings.cashWithRiders,
      },
      adminEarning: {
        total: adminEarningTotal,
        // Earning on delivered COD whose cash is still with a rider.
        pending: earnings.pending.earning,
        marginPercent:
          earnings.realized.billed > 0
            ? round2((adminEarningTotal / earnings.realized.billed) * 100)
            : 0,
      },
      riderEarning: {
        total: riderEarningTotal,
        // Earned vs actually paid out (settled withdrawals).
        paid: riderMoney.paid,
        owed: riderMoney.owed,
        riders: riderRows.length,
      },
      // All-services figures — see the function comment above.
      wallet: {
        totalBalance: walletBalanceTotal,
        pendingWithdrawals: pendingWithdrawalTotal,
        paidOut: paidOutTotal,
        scopeNote: "Wallet balance and withdrawals pool every job a rider has done, not courier jobs alone.",
      },
      riders: riderRows.slice(0, 100),
      syncedAt: new Date(),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Withdrawal requests from riders who do porter work — the "who still needs
 * to be paid" action list. Settling one is handled by the existing generic
 * `PUT /admin/transactions/:id/settle` (see walletAdminService.settleDeliveryTransactionById);
 * this endpoint only narrows WHICH rows the porter desk sees.
 */
export const adminGetPorterWalletWithdrawals = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
    const skip = (page - 1) * limit;
    const status = String(req.query?.status || "pending").toLowerCase();

    const riderIds = await getPorterRiderIds();
    if (!riderIds.length) {
      return handleResponse(res, 200, "Courier rider withdrawals", {
        items: [],
        page,
        limit,
        total: 0,
        totalPages: 1,
      });
    }

    const match = { userModel: "Delivery", type: "Withdrawal", user: { $in: riderIds } };
    if (status === "pending") match.status = { $in: ["Pending", "Processing"] };
    else if (status === "settled") match.status = "Settled";
    // status === "all" -> no status filter

    const [rows, total] = await Promise.all([
      Transaction.find(match)
        // Payout destination travels with the request so the admin can pay
        // without hunting for the rider's details on another screen. The
        // identity fields (photo, vehicle) let the admin confirm exactly
        // which rider this is before paying.
        .populate(
          "user",
          "name phone email profileImage vehicleType vehicleNumber currentArea isVerified accountHolder accountNumber ifsc bankName upiId qrImageUrl",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(match),
    ]);

    return handleResponse(res, 200, "Courier rider withdrawals", {
      items: rows.map((row) => ({
        id: String(row._id),
        rider: row.user?.name || "Rider",
        riderId: row.user?._id ? String(row.user._id) : "",
        riderPhone: row.user?.phone || "",
        riderEmail: row.user?.email || "",
        riderProfileImage: row.user?.profileImage || "",
        riderVehicleType: row.user?.vehicleType || "",
        riderVehicleNumber: row.user?.vehicleNumber || "",
        riderArea: row.user?.currentArea || "",
        riderVerified: Boolean(row.user?.isVerified),
        amount: round2(Math.abs(row.amount)),
        status: row.status,
        reference: row.reference,
        date: row.date || row.createdAt,
        payout: {
          accountHolder: row.user?.accountHolder || "",
          accountNumber: row.user?.accountNumber || "",
          ifsc: row.user?.ifsc || "",
          bankName: row.user?.bankName || "",
          upiId: row.user?.upiId || "",
          qrImageUrl: row.user?.qrImageUrl || "",
        },
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
