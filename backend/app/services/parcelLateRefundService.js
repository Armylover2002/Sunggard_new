import { roundCurrency } from "../utils/money.js";
import {
  LEDGER_TRANSACTION_TYPE,
  LEDGER_STATUS,
  OWNER_TYPE,
} from "../constants/finance.js";
import { creditWallet } from "./finance/walletService.js";

/** Normal parcel pickup SLA (minutes from rider accept). */
export const NORMAL_PICKUP_SLA_MINUTES = 30;

export function getParcelPickupSlaMinutes(parcel) {
  const speed = String(parcel?.deliverySpeed || "normal").toLowerCase();
  if (speed === "express") return 10;
  return NORMAL_PICKUP_SLA_MINUTES;
}

export function getParcelPickupDeadline(parcel) {
  if (!parcel?.acceptedAt) return null;
  const start = new Date(parcel.acceptedAt);
  if (!Number.isFinite(start.getTime())) return null;
  const minutes = getParcelPickupSlaMinutes(parcel);
  return new Date(start.getTime() + minutes * 60 * 1000);
}

/** True when Normal delivery and captain missed the 30-min pickup window. */
export function isNormalParcelPickupLate(parcel, at = new Date()) {
  if (String(parcel?.deliverySpeed || "normal").toLowerCase() !== "normal") {
    return false;
  }
  const deadline = getParcelPickupDeadline(parcel);
  if (!deadline) return false;
  return at.getTime() > deadline.getTime();
}

export function getParcelLatePickupSummary(parcel, at = new Date()) {
  const acceptedAt = parcel?.acceptedAt ? new Date(parcel.acceptedAt) : null;
  const deadlineAt = getParcelPickupDeadline(parcel);
  const slaMinutes = getParcelPickupSlaMinutes(parcel);
  if (!acceptedAt || !deadlineAt) {
    return null;
  }

  const status = String(parcel?.status || "");
  const pickedUp =
    status === "PICKED_UP" ||
    status === "OUT_FOR_DELIVERY" ||
    status === "DELIVERED";

  // Prefer snapshot from refund request; else pickup time heuristic; else now.
  const measuredAt = parcel?.lateRefundRequest?.measuredAt
    ? new Date(parcel.lateRefundRequest.measuredAt)
    : parcel?.lateRefundRequest?.requestedAt
      ? new Date(parcel.lateRefundRequest.requestedAt)
      : pickedUp && parcel?.updatedAt
        ? new Date(parcel.updatedAt)
        : at;

  const lateMs = Math.max(0, measuredAt.getTime() - deadlineAt.getTime());
  const lateByMinutes = Math.floor(lateMs / 60000);
  const lateBySeconds = Math.floor((lateMs % 60000) / 1000);
  const hours = Math.floor(lateByMinutes / 60);
  const mins = lateByMinutes % 60;
  let lateByLabel = "On time";
  if (lateMs > 0) {
    if (hours > 0) {
      lateByLabel = `${hours}h ${mins}m late`;
    } else if (lateByMinutes > 0) {
      lateByLabel = `${lateByMinutes} min late`;
    } else {
      lateByLabel = `${lateBySeconds}s late`;
    }
  }

  return {
    slaMinutes,
    acceptedAt,
    deadlineAt,
    measuredAt,
    lateMs,
    lateByMinutes,
    lateByLabel,
    isLate: lateMs > 0,
    stillAwaitingPickup: !pickedUp,
  };
}

export function canCustomerRequestLateRefund(parcel, at = new Date()) {
  if (!parcel) return { ok: false, message: "Courier not found" };
  if (String(parcel.customerId?._id || parcel.customerId) === "") {
    return { ok: false, message: "Invalid courier" };
  }
  if (parcel.status === "CANCELLED") {
    return { ok: false, message: "Cancelled couriers cannot request late refund" };
  }
  if (!parcel.acceptedAt || !parcel.deliveryPartnerId) {
    return { ok: false, message: "Refund is available only after a captain accepts" };
  }
  if (String(parcel.deliverySpeed || "normal").toLowerCase() !== "normal") {
    return { ok: false, message: "Late refund requests apply only to Normal (30 min) deliveries" };
  }
  if (!isNormalParcelPickupLate(parcel, at)) {
    return {
      ok: false,
      message: `Pickup is still within the ${NORMAL_PICKUP_SLA_MINUTES}-minute window`,
    };
  }
  const status = String(parcel.lateRefundRequest?.status || "none");
  if (status === "requested") {
    return { ok: false, message: "A late refund request is already pending admin review" };
  }
  if (status === "approved") {
    return { ok: false, message: "A late refund was already approved for this courier" };
  }
  return { ok: true };
}

export async function creditLateRefundToCustomerWallet(parcel, amount, adminId) {
  const creditAmount = roundCurrency(Number(amount) || 0);
  if (!(creditAmount > 0)) {
    throw Object.assign(new Error("Refund amount must be greater than 0"), { statusCode: 400 });
  }
  const customerId = parcel.customerId?._id || parcel.customerId;
  if (!customerId) {
    throw Object.assign(new Error("Customer missing on courier"), { statusCode: 400 });
  }

  await creditWallet({
    ownerType: OWNER_TYPE.CUSTOMER,
    ownerId: customerId,
    amount: creditAmount,
    ledgerType: LEDGER_TRANSACTION_TYPE.WALLET_REFUND,
    ledgerStatus: LEDGER_STATUS.COMPLETED,
    ledgerReference: `PCL-LATE-REFUND-${String(parcel._id)}`,
    ledgerDescription: `Admin late-pickup refund for courier #${String(parcel._id).slice(-6)}`,
    metadata: {
      kind: "parcel_late_refund",
      parcelId: String(parcel._id),
      adminId: adminId ? String(adminId) : null,
      fare: Number(parcel.fare) || 0,
      paymentMethod: parcel.paymentMethod,
    },
    idempotencyKey: `parcel-late-refund:${String(parcel._id)}`,
  });

  return creditAmount;
}
