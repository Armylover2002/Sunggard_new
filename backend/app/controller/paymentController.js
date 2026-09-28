import { processGatewayWebhook } from "../services/paymentService.js";
import logger from "../services/logger.js";

/**
 * Razorpay server-to-server webhook.
 *
 * Unauthenticated by design — the gateway cannot hold a user session. Trust
 * comes entirely from the HMAC over the raw request body, which is why this
 * route mounts a raw body parser and why an unsigned request is refused
 * before the payload is read.
 *
 * This is the only marketplace payment endpoint left after QC removal —
 * porter/parcel payments and rider cash deposits are routed to the porter
 * ledger inside `processGatewayWebhook` itself.
 */
export const handleGatewayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.body;

    if (!signature) {
      logger.warn("Gateway webhook missing signature header", {
        scope: "PaymentController.handleGatewayWebhook",
        correlationId: req.correlationId || null,
        ip: req.ip,
      });
      return res.status(401).send("Unauthorized");
    }

    const result = await processGatewayWebhook({
      rawBody,
      signature,
      correlationId: req.correlationId || null,
    });

    if (result.accepted) {
      return res.status(200).send("OK");
    }

    return res.status(400).send("Bad Request");
  } catch (error) {
    // A 5xx tells the gateway to retry, which is what we want for a transient
    // fault. A rejected signature is a 401 and is not worth retrying.
    const status = error?.statusCode === 401 ? 401 : 500;
    logger.error("Gateway webhook processing failed", {
      scope: "PaymentController.handleGatewayWebhook",
      correlationId: req.correlationId || null,
      message: error?.message,
      error,
    });
    return res.status(status).send(status === 401 ? "Unauthorized" : "Internal Server Error");
  }
};
