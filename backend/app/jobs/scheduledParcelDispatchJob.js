import { dispatchDueScheduledParcels } from "../services/parcelWorkflowService.js";
import logger from "../services/logger.js";

/**
 * Sends scheduled courier requests to riders when their pickup time arrives.
 * Runs every minute so a request goes out within about a minute of the time
 * the customer chose.
 */

const DEFAULT_INTERVAL_MS = 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.SCHEDULED_PARCEL_DISPATCH_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);

const sweep = async () => {
  try {
    const result = await dispatchDueScheduledParcels();
    if (result.released) {
      logger.info("Scheduled courier requests released", {
        jobName: "scheduledParcelDispatchJob",
        ...result,
      });
    }
  } catch (err) {
    logger.error("Scheduled courier dispatch failed", {
      jobName: "scheduledParcelDispatchJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getScheduledParcelDispatchJobHandler = () => sweep;
export const getScheduledParcelDispatchJobInterval = () => INTERVAL_MS;
export const isScheduledParcelDispatchJobEnabled = () =>
  process.env.SCHEDULED_PARCEL_DISPATCH_ENABLED !== "false";

export default sweep;
