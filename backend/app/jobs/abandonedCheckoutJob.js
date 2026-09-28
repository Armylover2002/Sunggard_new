import { sweepAbandonedCheckouts } from "../services/bookingCheckoutService.js";
import logger from "../services/logger.js";

/**
 * Clears out bookings whose payment sheet was opened and never completed.
 *
 * Parcel (outstation) inserts its row before the customer pays, because
 * the gateway order has to hang off something. Listings already hide those
 * rows (see services/bookingCheckoutService.js), but hidden is not gone:
 * without this they accumulate in the collection forever, one per abandoned
 * tap of "Pay", slowing every query that has to skip past them.
 *
 * Runs rarely on purpose. The rows are invisible either way, so nothing is
 * waiting on this; the only cost of a slow sweep is a little dead weight in
 * the collection, and a fast one would repeatedly scan for work that comes
 * up hours apart.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.ABANDONED_CHECKOUT_SWEEP_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const sweep = async () => {
  const startedAt = Date.now();

  try {
    const { parcels } = await sweepAbandonedCheckouts({ limit: 200 });

    if (parcels) {
      logger.info("Abandoned checkout sweep", {
        jobName: "abandonedCheckoutJob",
        parcels,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    logger.error("Abandoned checkout sweep failed", {
      jobName: "abandonedCheckoutJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getAbandonedCheckoutJobHandler = () => sweep;
export const getAbandonedCheckoutJobInterval = () => INTERVAL_MS;
export const isAbandonedCheckoutJobEnabled = () =>
  process.env.ABANDONED_CHECKOUT_SWEEP_ENABLED !== "false";

export default sweep;
