import { cancelStalledUnacceptedParcels } from "../services/parcelStalledSearchService.js";
import logger from "../services/logger.js";

/**
 * Cancels courier requests nobody ever accepted (still SEARCHING, or
 * REQUESTED because no rider was ever eligible). Runs every few minutes;
 * the window itself is enforced in the service.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.STALLED_SEARCH_SWEEP_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const sweep = async () => {
  try {
    const result = await cancelStalledUnacceptedParcels();
    if (result.cancelled) {
      logger.info("Stalled search parcel sweep", {
        jobName: "stalledSearchParcelJob",
        ...result,
      });
    }
  } catch (err) {
    logger.error("Stalled search parcel sweep failed", {
      jobName: "stalledSearchParcelJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getStalledSearchParcelJobHandler = () => sweep;
export const getStalledSearchParcelJobInterval = () => INTERVAL_MS;
export const isStalledSearchParcelJobEnabled = () =>
  process.env.STALLED_SEARCH_SWEEP_ENABLED !== "false";

export default sweep;
