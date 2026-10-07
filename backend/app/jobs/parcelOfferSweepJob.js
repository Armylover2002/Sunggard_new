import { sweepExpiredParcelOffers } from "../services/parcelWorkflowService.js";
import logger from "../services/logger.js";

/**
 * Recovers courier offer searches whose in-memory timeout timer was lost —
 * an API restart/redeploy wipes every pending timer, leaving the parcel
 * stuck SEARCHING forever with nobody new ever being offered it. Runs
 * often: the offer window itself is tens of seconds, so a sweep much
 * slower than that would leave a visibly stuck request for a while before
 * recovering it.
 */

const DEFAULT_INTERVAL_MS = 10 * 1000;

const INTERVAL_MS = parseInt(
  process.env.PARCEL_OFFER_SWEEP_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const sweep = async () => {
  try {
    const result = await sweepExpiredParcelOffers();
    if (result.found) {
      logger.info("Courier offer sweep recovered stuck searches", {
        jobName: "parcelOfferSweepJob",
        ...result,
      });
    }
  } catch (err) {
    logger.error("Courier offer sweep failed", {
      jobName: "parcelOfferSweepJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getParcelOfferSweepJobHandler = () => sweep;
export const getParcelOfferSweepJobInterval = () => INTERVAL_MS;
export const isParcelOfferSweepJobEnabled = () =>
  process.env.PARCEL_OFFER_SWEEP_ENABLED !== "false";

export default sweep;
