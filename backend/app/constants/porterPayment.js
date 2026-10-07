/**
 * Payment vocabulary for the porter desk (local City Parcel + outstation
 * Parcel bookings, doorstep COD conversions, and rider cash deposits).
 *
 * Deliberately its own file rather than an extension of `constants/payment.js`.
 * That one describes the marketplace order payment, which is keyed on an
 * Order and settles to a seller. A porter payment has no seller, no line
 * items, and three different reasons for existing — sharing an enum would
 * force every future change to either to be reasoned about twice.
 *
 * The status values themselves intentionally MATCH `PAYMENT_STATUS` so a
 * single Razorpay adapter can map a gateway state once and both ledgers can
 * read it. Only the transition table and the sources differ.
 */

/** Which collection the money is for. */
export const PORTER_BOOKING_KIND = {
  CITY_PARCEL: "city_parcel",
  PARCEL: "parcel",
};

export const ALL_PORTER_BOOKING_KINDS = Object.values(PORTER_BOOKING_KIND);

/**
 * Why this payment exists.
 *
 * BOOKING          — customer paying for a booking at checkout.
 * COD_DOORSTEP     — a COD customer choosing to pay digitally at handover.
 * RIDER_CASH_DEPOSIT — a rider returning collected COD cash to the platform
 *                      online, instead of the old transfer-and-screenshot.
 * WALLET_TOPUP       — a customer adding money to their wallet. Credited to
 *                      the wallet only once the gateway has CAPTURED it.
 */
export const PORTER_PAYMENT_PURPOSE = {
  BOOKING: "BOOKING",
  COD_DOORSTEP: "COD_DOORSTEP",
  RIDER_CASH_DEPOSIT: "RIDER_CASH_DEPOSIT",
  /** A customer adding money to their own wallet through the gateway. */
  WALLET_TOPUP: "WALLET_TOPUP",
};

export const ALL_PORTER_PAYMENT_PURPOSES = Object.values(PORTER_PAYMENT_PURPOSE);

/** Who the money moved between. Decides which side the ledger row lands on. */
export const PORTER_PAYER_TYPE = {
  CUSTOMER: "CUSTOMER",
  RIDER: "RIDER",
};

export const ALL_PORTER_PAYER_TYPES = Object.values(PORTER_PAYER_TYPE);

export const PORTER_PAYMENT_STATUS = {
  CREATED: "CREATED",
  PENDING: "PENDING",
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
};

export const ALL_PORTER_PAYMENT_STATUSES = Object.values(PORTER_PAYMENT_STATUS);

/** Statuses that mean the platform actually holds the money. */
export const PORTER_PAID_STATUSES = [
  PORTER_PAYMENT_STATUS.CAPTURED,
  PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED,
];

/** Statuses a checkout can still be resumed from. */
export const PORTER_OPEN_STATUSES = [
  PORTER_PAYMENT_STATUS.CREATED,
  PORTER_PAYMENT_STATUS.PENDING,
];

/** What told us about the change. Kept on every history row. */
export const PORTER_PAYMENT_SOURCE = {
  /** Server opened the gateway order. */
  SYSTEM: "SYSTEM",
  /** The signed receipt checkout handed back to the browser. */
  CLIENT_VERIFY: "CLIENT_VERIFY",
  /** Server-to-server event from the gateway. */
  WEBHOOK: "WEBHOOK",
  /** A status read back from the gateway on demand. */
  RECONCILIATION: "RECONCILIATION",
  /** An admin acting on the row by hand. */
  ADMIN: "ADMIN",
};

export const ALL_PORTER_PAYMENT_SOURCES = Object.values(PORTER_PAYMENT_SOURCE);

/**
 * Legal state changes.
 *
 * A terminal status has no outgoing edges on purpose: a late webhook for an
 * attempt that already failed must not be able to resurrect it, and a
 * captured payment can only ever move to refunded. Without this table a
 * redelivered `payment.failed` arriving after `payment.captured` — which
 * Razorpay does send, out of order, on a retried checkout — would flip a paid
 * booking back to unpaid.
 */
const TRANSITIONS = {
  [PORTER_PAYMENT_STATUS.CREATED]: new Set([
    PORTER_PAYMENT_STATUS.PENDING,
    PORTER_PAYMENT_STATUS.AUTHORIZED,
    PORTER_PAYMENT_STATUS.CAPTURED,
    PORTER_PAYMENT_STATUS.FAILED,
    PORTER_PAYMENT_STATUS.CANCELLED,
  ]),
  [PORTER_PAYMENT_STATUS.PENDING]: new Set([
    PORTER_PAYMENT_STATUS.AUTHORIZED,
    PORTER_PAYMENT_STATUS.CAPTURED,
    PORTER_PAYMENT_STATUS.FAILED,
    PORTER_PAYMENT_STATUS.CANCELLED,
  ]),
  [PORTER_PAYMENT_STATUS.AUTHORIZED]: new Set([
    PORTER_PAYMENT_STATUS.CAPTURED,
    PORTER_PAYMENT_STATUS.FAILED,
    PORTER_PAYMENT_STATUS.CANCELLED,
    PORTER_PAYMENT_STATUS.REFUNDED,
  ]),
  [PORTER_PAYMENT_STATUS.CAPTURED]: new Set([
    PORTER_PAYMENT_STATUS.REFUNDED,
    PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED,
  ]),
  [PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED]: new Set([
    PORTER_PAYMENT_STATUS.REFUNDED,
    PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED,
  ]),
  [PORTER_PAYMENT_STATUS.FAILED]: new Set([]),
  [PORTER_PAYMENT_STATUS.CANCELLED]: new Set([]),
  [PORTER_PAYMENT_STATUS.REFUNDED]: new Set([]),
};

export function canTransitionPorterPayment(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return true;
  return TRANSITIONS[fromStatus]?.has(toStatus) || false;
}

/**
 * How a booking's own `paymentStatus` field should read for a given gateway
 * status. The booking documents carry a coarse four-value field that the
 * customer and rider apps render directly; this is the single place the two
 * vocabularies are reconciled.
 */
export function bookingPaymentStatusFor(porterStatus) {
  switch (porterStatus) {
    case PORTER_PAYMENT_STATUS.CAPTURED:
    case PORTER_PAYMENT_STATUS.PARTIALLY_REFUNDED:
      return "PAID";
    case PORTER_PAYMENT_STATUS.REFUNDED:
      return "REFUNDED";
    case PORTER_PAYMENT_STATUS.FAILED:
    case PORTER_PAYMENT_STATUS.CANCELLED:
      return "FAILED";
    default:
      return "PENDING";
  }
}
