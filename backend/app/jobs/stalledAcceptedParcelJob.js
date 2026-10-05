import { cancelStalledAcceptedParcels } from "../services/parcelStalledAcceptService.js";
import logger from "../services/logger.js";

/**
 * Cancels courier requests a rider accepted but never moved forward.
 * Runs every few minutes; the 3-hour window is enforced in the service.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.STALLED_ACCEPT_SWEEP_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const sweep = async () => {
  try {
    const result = await cancelStalledAcceptedParcels();
    if (result.cancelled) {
      logger.info("Stalled accepted parcel sweep", {
        jobName: "stalledAcceptedParcelJob",
        ...result,
      });
    }
  } catch (err) {
    logger.error("Stalled accepted parcel sweep failed", {
      jobName: "stalledAcceptedParcelJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getStalledAcceptedParcelJobHandler = () => sweep;
export const getStalledAcceptedParcelJobInterval = () => INTERVAL_MS;
export const isStalledAcceptedParcelJobEnabled = () =>
  process.env.STALLED_ACCEPT_SWEEP_ENABLED !== "false";

export default sweep;
