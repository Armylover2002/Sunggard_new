import Transaction from "../models/transaction.js";
import Delivery from "../models/delivery.js";
import handleResponse from "../utils/helper.js";
import mongoose from "mongoose";
import {
  writeDeliveryLocation,
  appendTrailPoint,
  clearOrderTracking,
  clearRiderPresence,
} from "../services/firebaseService.js";
import { roundCurrency } from "../utils/money.js";
import logger from "../services/logger.js";
import { shouldThrottle as throttleLocationUpdate } from "../services/delivery/locationThrottleService.js";
import {
  getDeliveryStats as getDeliveryStatsFromService,
  getDeliveryEarnings as getDeliveryEarningsFromService,
} from "../services/delivery/deliveryEarningsService.js";
import Parcel from "../models/parcel.js";
import ParcelConfig from "../models/parcelConfig.js";
import { computeRiderParcelEarnings } from "../services/parcelWorkflowService.js";
import { emitToOrder } from "../services/orderSocketEmitter.js";

const PARCEL_ACTIVE_STATUSES = new Set([
  "REQUESTED",
  "SEARCHING",
  "ACCEPTED",
  "RIDER_ASSIGNED",
  "PICKUP_REACHED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
]);

function mapParcelForDeliveryHistory(parcel, deliveryBoyId, settings) {
  const riderId = String(deliveryBoyId);
  const assignedToMe =
    parcel.deliveryPartnerId != null &&
    String(parcel.deliveryPartnerId?._id || parcel.deliveryPartnerId) === riderId;
  const rejectedByMe =
    !assignedToMe &&
    Array.isArray(parcel.skippedBy) &&
    parcel.skippedBy.some((id) => String(id) === riderId);

  const status = rejectedByMe ? "REJECTED" : String(parcel.status || "REQUESTED").toUpperCase();
  const sellerDoc =
    parcel.sellerId && typeof parcel.sellerId === "object" ? parcel.sellerId : null;
  const customerDoc =
    parcel.customerId && typeof parcel.customerId === "object" ? parcel.customerId : null;

  const earnings = assignedToMe
    ? computeRiderParcelEarnings(parcel, settings)
    : 0;

  return {
    kind: "parcel",
    _id: parcel._id,
    orderId: `PCL-${String(parcel._id).slice(-6).toUpperCase()}`,
    status: status.toLowerCase(),
    workflowStatus: status,
    historyRole: rejectedByMe ? "rejected" : assignedToMe ? "assigned" : "related",
    createdAt: parcel.createdAt,
    updatedAt: parcel.updatedAt,
    customer: customerDoc
      ? { name: customerDoc.name, phone: customerDoc.phone }
      : {
          name: parcel.pickupAddress?.name || "Customer",
          phone: parcel.pickupAddress?.phone || "",
        },
    seller: {
      shopName: sellerDoc?.shopName || sellerDoc?.name || "Parcel hub",
      address: sellerDoc?.address || "",
    },
    pickupAddress: parcel.pickupAddress,
    dropAddress: parcel.dropAddress,
    fare: Number(parcel.fare) || 0,
    distance: Number(parcel.distance) || 0,
    paymentMethod: parcel.paymentMethod,
    deliverySpeed: parcel.deliverySpeed,
    pricing: { total: Number(parcel.fare) || 0 },
    earnings,
    riderEarnings: earnings,
  };
}

function parcelMatchesHistoryFilter(item, normalized) {
  const status = String(item.workflowStatus || item.status || "").toUpperCase();
  if (normalized === "all") return true;
  if (normalized === "delivered") return status === "DELIVERED";
  if (normalized === "cancelled") return status === "CANCELLED";
  if (normalized === "rejected") return status === "REJECTED" || item.historyRole === "rejected";
  if (normalized === "active") return PARCEL_ACTIVE_STATUSES.has(status);
  if (normalized === "returns") return false;
  return true;
}

/* ===============================
   GET DELIVERY DASHBOARD STATS
================================ */
export const getDeliveryStats = async (req, res) => {
    try {
        const result = await getDeliveryStatsFromService(req.user.id);
        return handleResponse(res, 200, "Stats fetched", result);
    } catch (error) {
        return handleResponse(res, error.statusCode || 500, error.message);
    }
};

/* ===============================
   GET DELIVERY EARNINGS
================================ */
export const getDeliveryEarnings = async (req, res) => {
    try {
        const result = await getDeliveryEarningsFromService(req.user.id);
        return handleResponse(res, 200, "Earnings fetched", result);
    } catch (error) {
        return handleResponse(res, error.statusCode || 500, error.message);
    }
};

/* ===============================
   GET DELIVERY ORDER HISTORY
   COD cash summary/submission (Order-based) removed with QC — Porter's
   rider COD cash flow lives in services/riderCashService.js instead.
================================ */
export const getMyDeliveryOrders = async (req, res) => {
    try {
        const rawId = req.user?.id ?? req.user?._id;
        if (!rawId) {
            return handleResponse(res, 401, "Unauthorized");
        }
        if (!mongoose.Types.ObjectId.isValid(String(rawId))) {
            return handleResponse(res, 401, "Invalid user id");
        }
        const deliveryBoyId = new mongoose.Types.ObjectId(String(rawId));
        const { status } = req.query;
        const normalized = (status || "all").toLowerCase();

        const [parcelDocs, parcelSettings] = await Promise.all([
            Parcel.find({
                $or: [
                    { deliveryPartnerId: deliveryBoyId },
                    { skippedBy: deliveryBoyId },
                ],
            })
                .select("-otp")
                .populate("customerId", "name phone")
                .populate("sellerId", "name shopName phone address")
                .sort({ createdAt: -1 })
                .limit(100)
                .lean(),
            ParcelConfig.getSearchSettings().catch(() => ({
                riderBaseFareSharePercent: 80,
                riderDistanceFareSharePercent: 80,
                riderSharePercent: 80,
            })),
        ]);

        const parcelItems = (parcelDocs || [])
            .map((p) => mapParcelForDeliveryHistory(p, deliveryBoyId, parcelSettings))
            .filter((item) => parcelMatchesHistoryFilter(item, normalized));

        const sorted = parcelItems.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        return handleResponse(res, 200, "Delivery orders fetched", sorted.slice(0, 150));
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   REQUEST WITHDRAWAL (Delivery)
================================ */
/** Below this a payout costs more in transfer fees than it moves. */
const MIN_WITHDRAWAL_AMOUNT = 100;

/**
 * Earnings a rider may draw against.
 *
 * Deliberately the same formula as `deliveryEarningsService.getDeliveryEarnings`
 * so the number here can never disagree with the one on the rider's own
 * earnings screen. The previous version summed EVERY settled row — including
 * cash-settlement debits and adjustments — which made the two screens quote
 * different balances for the same rider.
 */
function computeWithdrawableBalance(transactions) {
    const earned = transactions
        .filter(
            (t) =>
                t.status === "Settled" &&
                ["Delivery Earning", "Incentive", "Bonus"].includes(t.type),
        )
        .reduce((acc, t) => acc + Math.abs(Number(t.amount) || 0), 0);

    const withdrawn = transactions
        .filter((t) => t.type === "Withdrawal" && t.status === "Settled")
        .reduce((acc, t) => acc + Math.abs(Number(t.amount) || 0), 0);

    const inFlight = transactions
        .filter(
            (t) =>
                t.type === "Withdrawal" &&
                (t.status === "Pending" || t.status === "Processing"),
        )
        .reduce((acc, t) => acc + Math.abs(Number(t.amount) || 0), 0);

    return {
        available: roundCurrency(Math.max(0, earned - withdrawn - inFlight)),
        inFlight: roundCurrency(inFlight),
    };
}

export const requestWithdrawal = async (req, res) => {
    try {
        const deliveryBoyId = req.user.id;
        const amount = roundCurrency(Number(req.body?.amount));

        if (!Number.isFinite(amount) || amount <= 0) {
            return handleResponse(res, 400, "Please enter a valid amount");
        }
        if (amount < MIN_WITHDRAWAL_AMOUNT) {
            return handleResponse(
                res,
                400,
                `Minimum withdrawal is ₹${MIN_WITHDRAWAL_AMOUNT}`,
            );
        }

        // A withdrawal with no destination is one the admin has to approve
        // blind, then chase the rider for account details out-of-band.
        const rider = await Delivery.findById(deliveryBoyId)
            .select("name phone accountHolder accountNumber ifsc bankName upiId qrImageUrl")
            .lean();
        if (!rider) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        const payout = {
            accountHolder: rider.accountHolder || "",
            accountNumber: rider.accountNumber || "",
            ifsc: rider.ifsc || "",
            bankName: rider.bankName || "",
            upiId: rider.upiId || "",
            qrImageUrl: rider.qrImageUrl || "",
        };
        const hasBank = Boolean(payout.accountHolder && payout.accountNumber && payout.ifsc);
        if (!hasBank && !payout.upiId && !payout.qrImageUrl) {
            return handleResponse(
                res,
                400,
                "Add your payout details first — bank account, UPI ID or a QR image",
            );
        }

        const transactions = await Transaction.find({
            user: deliveryBoyId,
            userModel: "Delivery",
        })
            .select("type status amount")
            .lean();

        const { available, inFlight } = computeWithdrawableBalance(transactions);

        // One request at a time. Two pending requests against one balance is
        // how a rider ends up paid twice for the same earnings.
        if (inFlight > 0) {
            return handleResponse(
                res,
                409,
                `You already have a withdrawal of ₹${inFlight} awaiting approval`,
            );
        }

        if (amount > available) {
            return handleResponse(res, 400, `Insufficient balance. Available: ₹${available}`);
        }

        const withdrawal = await Transaction.create({
            user: deliveryBoyId,
            userModel: "Delivery",
            type: "Withdrawal",
            amount: -Math.abs(amount),
            status: "Pending",
            reference: `WDR-DL-${Date.now()}`,
            // Snapshotted so the admin sees the destination as it stood when
            // the request was raised, even if the rider edits it afterwards.
            meta: { payout, requestedBalance: available },
        });

        return handleResponse(res, 201, "Withdrawal request submitted successfully", withdrawal);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE LIVE LOCATION (Delivery)
================================ */
export const updateDeliveryLocation = async (req, res) => {
    try {
        const deliveryId = req.user.id;
        const { lat, lng, accuracy, heading, speed, orderId } = req.body || {};

        if (
            typeof lat !== "number" ||
            typeof lng !== "number" ||
            Number.isNaN(lat) ||
            Number.isNaN(lng)
        ) {
            return handleResponse(res, 400, "Valid numeric lat and lng are required");
        }

        const throttled = await throttleLocationUpdate(deliveryId, lat, lng);
        if (throttled) {
            return handleResponse(res, 200, "Location update throttled", {
                throttled: true,
            });
        }

        // Normalize to [lng, lat] as required by GeoJSON
        const coordinates = [Number(lng), Number(lat)];

        const delivery = await Delivery.findByIdAndUpdate(
            deliveryId,
            {
                $set: {
                    location: {
                        type: "Point",
                        coordinates,
                    },
                    lastLocationAt: new Date(),
                },
            },
            { new: true }
        ).select("_id location isOnline");

        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        // SECURITY: when an orderId (here, a parcel id) is supplied, the rider
        // is telling us which active delivery this ping belongs to. We MUST
        // verify the assignment synchronously before fanning out to Firebase —
        // otherwise a rider can pollute another job's live-tracking path (and
        // the customer map would render the wrong rider).
        //
        // Rules:
        //   - orderId omitted           -> only the delivery-keyed RTDB entry is
        //                                  written (no per-job fanout). Trail
        //                                  is skipped. This preserves the
        //                                  "background heartbeat" code path.
        //   - orderId references a doc  -> rider must equal parcel.deliveryPartnerId,
        //                                  otherwise 403/404 and no RTDB write.
        //   - canonical id              -> always read from Mongo, never trusted
        //                                  as-is from the request body.
        let activeOrderId = null;
        if (orderId) {
            const trimmedId = String(orderId).trim();
            if (!mongoose.Types.ObjectId.isValid(trimmedId)) {
                return handleResponse(res, 400, "Invalid orderId");
            }

            const parcel = await Parcel.findById(trimmedId)
                .select("deliveryPartnerId")
                .lean();

            if (!parcel) {
                return handleResponse(res, 404, "Parcel not found");
            }

            const assignedRiderId = parcel.deliveryPartnerId
                ? String(parcel.deliveryPartnerId)
                : null;
            if (assignedRiderId !== String(deliveryId)) {
                return handleResponse(
                    res,
                    403,
                    "Parcel is not assigned to this delivery partner"
                );
            }

            activeOrderId = String(parcel._id);
        }

        const snapshot = {
            lat,
            lng,
            accuracy: typeof accuracy === "number" ? accuracy : undefined,
            heading: typeof heading === "number" ? heading : undefined,
            speed: typeof speed === "number" ? speed : undefined,
            lastUpdatedAt: new Date().toISOString(),
            deliveryId,
            orderId: activeOrderId,
        };

        // Fan out to Firebase and trail — fire-and-forget, never block the
        // response. Reaching this line guarantees activeOrderId (if set) is
        // the canonical id of an order this rider is actually assigned to.
        writeDeliveryLocation(deliveryId, activeOrderId, snapshot).catch(() => {});
        if (activeOrderId) {
            appendTrailPoint(activeOrderId, { lat, lng, t: Date.now() }).catch(() => {});

            // Real-time map tracking: push the fix straight to whoever has
            // joined this parcel's socket room (customer + rider screens),
            // instead of leaving them to poll the parcel doc or Firebase.
            emitToOrder(activeOrderId, {
                event: "location:update",
                payload: {
                    parcelId: activeOrderId,
                    lat,
                    lng,
                    heading: typeof heading === "number" ? heading : undefined,
                    speed: typeof speed === "number" ? speed : undefined,
                    at: new Date().toISOString(),
                },
            });
        }

        return handleResponse(res, 200, "Location updated", {
            location: delivery.location,
            activeOrderId,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
/*
 * DEPRECATED + REMOVED: Delivery-completion OTP generation/validation moved
 * to the canonical workflow service:
 *   POST /orders/workflow/:orderId/otp/request  -> requestHandoffOtpAtomic
 *   POST /orders/workflow/:orderId/otp/verify   -> verifyHandoffOtpAndDeliver
 *
 * The previous generateDeliveryOtp / validateDeliveryOtp controllers
 * and their /delivery/orders/:orderId/(generate|validate)-otp routes
 * were removed once the workflow state machine became the single source
 * of truth for delivery completion. All behaviors (Delivery.location
 * fallback, proximity check, Firebase tracking cleanup on success,
 * structured OTP error codes, otpValidatedAt + otpValidationLocation
 * persistence, delivery:otp:validated socket fan-out) now live in
 * app/services/orderWorkflowService.js.
 */