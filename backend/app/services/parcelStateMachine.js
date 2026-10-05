/**
 * Legal status moves for an outstation (pickup-service) parcel.
 *
 * The rider endpoint used to validate only the status being asked for,
 * against a flat allow-list of every non-terminal name. Whether the parcel
 * could actually get there from where it was standing went unchecked, so a
 * rider one tap away from OUT_FOR_DELIVERY could set it directly from
 * ACCEPTED — skipping PICKUP_REACHED and PICKED_UP, and with them the pickup
 * OTP and the proof photo that are the only evidence the parcel ever changed
 * hands. The same gap let a status move backwards, which wrote a timeline
 * that told a story the parcel had not lived.
 *
 * This is the ordered version of that check. This flow ends when the parcel
 * reaches a courier hub, so it has no receiver handover, no failed attempt
 * and no return leg to express.
 */

/** from -> the statuses reachable from it */
const TRANSITIONS = {
  REQUESTED: new Set(["SEARCHING", "CANCELLED"]),

  // A search that nobody accepts falls back to REQUESTED for an admin to
  // assign by hand; an admin may also assign a rider straight out of it.
  SEARCHING: new Set(["ACCEPTED", "REQUESTED", "CANCELLED"]),

  // RIDER_ASSIGNED is an optional "on my way" beat, so a rider who reaches
  // the door before tapping it is not stuck.
  ACCEPTED: new Set(["RIDER_ASSIGNED", "PICKUP_REACHED", "CANCELLED"]),
  RIDER_ASSIGNED: new Set(["PICKUP_REACHED", "CANCELLED"]),
  PICKUP_REACHED: new Set(["PICKED_UP", "CANCELLED"]),

  // Once the rider holds the parcel there is nothing left to cancel, and
  // there is no separate courier-hub visit to wait for either: pickup from
  // the customer (OTP + photo proof) is the delivery, so riderUpdateStatus
  // moves PICKED_UP straight to DELIVERED within the same request.
  // OUT_FOR_DELIVERY stays a valid enum value on the Parcel model for any
  // historical rows that used it, but the transition path no longer goes
  // through it.
  PICKED_UP: new Set(["DELIVERED"]),
  OUT_FOR_DELIVERY: new Set(["DELIVERED"]),

  DELIVERED: new Set(),
  CANCELLED: new Set(),
};

export const PARCEL_TERMINAL_STATUSES = ["DELIVERED", "CANCELLED"];

/**
 * Can a parcel at `from` move to `to`?
 *
 * A status equal to the current one is NOT a transition and is reported as
 * such — callers treat it as a no-op rather than replaying the side effects
 * of arriving there, which would append a second timeline row for a step
 * that happened once.
 */
export function canTransition(from, to) {
  if (!from || !to || from === to) return false;
  const allowed = TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

export function isTerminal(status) {
  return PARCEL_TERMINAL_STATUSES.includes(status);
}

/** Which statuses a parcel in `from` could legally reach next. */
export function nextStatuses(from) {
  return Array.from(TRANSITIONS[from] || []);
}

/**
 * Why a move was refused, phrased for the rider holding the phone.
 *
 * "Invalid status transition" tells them nothing they can act on. Being told
 * the parcel has already been dropped, or that pickup has to be confirmed
 * first, points at the screen they actually need.
 */
export function transitionRefusal(from, to) {
  if (isTerminal(from)) {
    return from === "DELIVERED"
      ? "This courier has already been dropped at the hub."
      : "This courier was cancelled.";
  }
  if (from === to) return null;
  return `This courier is ${String(from || "")
    .toLowerCase()
    .replace(/_/g, " ")} — confirm the steps in order before moving it there.`;
}

export default { canTransition, isTerminal, nextStatuses, transitionRefusal };
