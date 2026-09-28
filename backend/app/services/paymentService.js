import crypto from "crypto";

import PaymentWebhookEvent from "../models/paymentWebhookEvent.js";
import Payment from "../models/payment.js";
import { getActivePaymentProvider } from "./payment/providerRegistry.js";

/**
 * Applies a gateway webhook.
 *
 * Porter (parcel/city-parcel) booking payments and rider cash deposits are
 * the only thing this handles now — the marketplace order-checkout payment
 * flow (create-order / verify / status polling, and this webhook's
 * matched-`Payment`-row branch that fed Order side effects) was removed
 * with the rest of QC.
 *
 * The gateway has one webhook endpoint and one signing secret per account,
 * so every porter booking payment and every rider cash deposit arrives
 * here. Signature is checked over the raw bytes before anything is read
 * out of the body.
 */
export async function processGatewayWebhook({
  rawBody,
  signature,
  correlationId = null,
}) {
  const provider = getActivePaymentProvider();

  const isValid = await provider.validateWebhook({ rawBody, signature });
  if (!isValid) {
    const err = new Error("Invalid webhook signature");
    err.statusCode = 401;
    throw err;
  }

  const decoded = await provider.decodeWebhookPayload({ rawBody });

  const eventId = decoded.eventId;
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(decoded.raw))
    .digest("hex");
  const eventType = decoded.eventType || decoded.state || "unknown";

  try {
    await PaymentWebhookEvent.create({
      eventId,
      gatewayName: provider.providerName,
      eventType,
      payloadHash,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return { duplicate: true, accepted: true };
    }
    throw error;
  }

  // Either identifier finds a legacy marketplace `Payment` row. That flow
  // is gone, so a match here (only possible against pre-existing data) is
  // not processed further — only the porter ledger below is live.
  const lookup = [];
  if (decoded.gatewayOrderId) lookup.push({ gatewayOrderId: decoded.gatewayOrderId });
  if (decoded.merchantOrderId) {
    lookup.push({ merchantOrderId: decoded.merchantOrderId });
    lookup.push({ gatewayOrderId: decoded.merchantOrderId });
  }
  const payment = lookup.length ? await Payment.findOne({ $or: lookup }) : null;
  if (payment) {
    return { accepted: true, ignored: true, reason: "Legacy marketplace payment record" };
  }

  const { applyPorterWebhook } = await import("./porter/porterPaymentService.js");
  const { activatePorterBookingAfterPayment } = await import(
    "./porter/porterDispatchService.js"
  );

  const porterResult = await applyPorterWebhook(decoded, {
    onPaid: activatePorterBookingAfterPayment,
  });

  if (porterResult.matched) {
    await PaymentWebhookEvent.updateOne(
      { eventId },
      { $set: { porterPayment: porterResult.payment._id } },
    );
    return {
      accepted: true,
      duplicate: Boolean(porterResult.duplicate),
      ledger: "porter",
      paymentStatus: porterResult.status,
    };
  }

  return { accepted: true, ignored: true, reason: "Payment attempt not found" };
}
