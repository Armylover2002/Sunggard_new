import Parcel from "../models/parcel.js";
import ParcelEvent from "../models/parcelEvent.js";
import logger from "./logger.js";

/**
 * Bookings that exist only to hold a payment gateway order open.
 *
 * Parcel (outstation) writes its row to the database BEFORE the customer has
 * paid, because Razorpay needs something to hang an order id off and the
 * signature that comes back has to be matched against a booking we already
 * know about. That row is scaffolding, not a booking: nobody has been
 * dispatched, no money has moved, and the customer may simply close the
 * sheet and walk away.
 *
 * Until this module existed, that scaffolding was indistinguishable from a
 * real booking everywhere it was counted — the customer's own waybill
 * history listed deliveries they had never paid for, the admin console
 * showed them as live REQUESTED jobs, and the porter-customer desk counted
 * them into "total bookings" and lifetime spend. Somebody who opened the pay
 * screen twice and left had two phantom bookings to explain.
 *
 * Two halves, deliberately in one file so they cannot drift apart:
 *
 *   - the match that says "this is an open checkout, not a booking", used
 *     to filter every customer- and admin-facing listing;
 *   - the sweep that removes those rows once the sheet can no longer be
 *     paid, so they do not accumulate forever.
 */

/**
 * How long an unpaid booking stays alive before the sweep removes it.
 *
 * Comfortably longer than a Razorpay sheet stays useful (a UPI collect
 * request expires well inside this) but short enough that a customer who
 * comes back the next day is quoted fresh rather than resuming a stale
 * route and price. Also longer than the resumable-booking window, so
 * tapping Pay again always finds its own row to reuse rather than being
 * given a new one because the sweep beat them to it.
 */
export const ABANDONED_CHECKOUT_TTL_MS = () =>
  parseInt(process.env.ABANDONED_CHECKOUT_TTL_MS || `${2 * 60 * 60 * 1000}`, 10);

/**
 * An outstation parcel still waiting on its gateway sheet.
 *
 * Narrower than the city one on purpose: only UPI opens a Razorpay sheet
 * here. CARD and WALLET bookings are activated immediately by createParcel
 * and legitimately sit at paymentStatus PENDING, and a search that nobody
 * accepts drops a parcel back to REQUESTED — matching on method alone would
 * hide both of those real bookings.
 */
export const PARCEL_AWAITING_PAYMENT = Object.freeze({
  status: "REQUESTED",
  paymentStatus: { $ne: "PAID" },
  paymentMethod: "UPI",
});

/**
 * Add "and it is not an unpaid checkout" to a query filter.
 *
 * `$nor` rather than negating each field: the clauses only describe an open
 * checkout when they are all true together, and spelling that out as
 * separate `$ne`s would exclude, for example, every COD booking.
 *
 * @param {Object} filter    the caller's own filter, returned unmodified
 * @param {Object} awaiting  PARCEL_AWAITING_PAYMENT
 */
export function excludeAwaitingPayment(filter = {}, awaiting) {
  const existingNor = Array.isArray(filter.$nor) ? filter.$nor : [];
  return { ...filter, $nor: [...existingNor, awaiting] };
}

/** Shorthand for the callers that always mean the same collection. */
export const visibleParcels = (filter = {}) =>
  excludeAwaitingPayment(filter, PARCEL_AWAITING_PAYMENT);

/**
 * Aggregation-pipeline form of the same rule.
 *
 * `$nor` is a query operator and works unchanged inside `$match`, so the
 * porter reporting pipelines share the exact predicate the listings use
 * rather than restating it and risking a different answer.
 */
export const parcelVisibleMatch = (extra = {}) => visibleParcels(extra);

/**
 * Delete unpaid bookings whose gateway sheet has gone cold.
 *
 * Deleted rather than cancelled, because these were never bookings. A
 * CANCELLED row is a promise the platform made and then broke, and it shows
 * up in a customer's history and an admin's cancellation rate as exactly
 * that. An abandoned checkout is a customer who changed their mind before
 * paying — leaving a tombstone behind would recreate, in a quieter form,
 * the phantom bookings this whole module exists to remove.
 *
 * Their timeline rows go with them: an event trail for a booking that no
 * longer exists is unreadable noise.
 *
 * Idempotent and bounded, so it is safe to run on a short schedule and on
 * every instance behind the distributed scheduler's lock.
 */
export async function sweepAbandonedCheckouts({ limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - ABANDONED_CHECKOUT_TTL_MS());
  const result = { parcels: 0 };

  try {
    const staleParcels = await Parcel.find({
      ...PARCEL_AWAITING_PAYMENT,
      createdAt: { $lt: cutoff },
    })
      .select("_id")
      .limit(limit)
      .lean();

    if (staleParcels.length) {
      const ids = staleParcels.map((row) => row._id);
      await ParcelEvent.deleteMany({ parcelId: { $in: ids } });
      const { deletedCount } = await Parcel.deleteMany({ _id: { $in: ids } });
      result.parcels = deletedCount || 0;
    }
  } catch (err) {
    logger.error("Abandoned parcel checkout sweep failed", {
      error: err?.message,
    });
  }

  return result;
}
