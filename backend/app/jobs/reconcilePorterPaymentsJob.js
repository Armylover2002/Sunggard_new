import {
  findStalePorterPayments,
  reconcileFromGateway,
} from "../services/porter/porterPaymentService.js";
import logger from "../services/logger.js";

/**
 * Safety net for a Porter booking payment whose confirmation never arrived
 * any other way.
 *
 * There are two paths that normally mark a payment CAPTURED: the Razorpay
 * webhook, and the client calling /verify right after checkout closes. Both
 * can miss — a webhook secret that isn't configured yet, a customer who kills
 * the app the instant the payment sheet closes, a dropped connection. When
 * that happens the money is already captured on Razorpay's side but the
 * booking still reads PENDING here, which is the one outcome worse than a
 * failed payment: the platform is holding funds against a booking nobody can
 * see paid.
 *
 * This sweep re-reads the authoritative status from Razorpay for anything
 * stuck past the grace period and applies it exactly the way the webhook
 * would — same `reconcileFromGateway`, same side effects, same idempotency.
 * It exists as its own job (not folded into abandonedCheckoutJob) because a
 * payment that actually captured must never be swept as abandoned.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_MINUTES = 15;

const INTERVAL_MS = parseInt(
  process.env.PORTER_PAYMENT_RECONCILE_INTERVAL_MS || `${DEFAULT_INTERVAL_MS}`,
  10,
);
const STALE_AFTER_MINUTES = parseInt(
  process.env.PORTER_PAYMENT_RECONCILE_STALE_AFTER_MINUTES ||
    `${DEFAULT_STALE_AFTER_MINUTES}`,
  10,
);

const reconcile = async () => {
  const startedAt = Date.now();

  try {
    const { activatePorterBookingAfterPayment } = await import(
      "../services/porter/porterDispatchService.js"
    );

    const stale = await findStalePorterPayments({
      olderThanMinutes: STALE_AFTER_MINUTES,
      limit: 100,
    });

    let changed = 0;
    let errored = 0;

    for (const payment of stale) {
      try {
        const result = await reconcileFromGateway(payment, {
          onPaid: activatePorterBookingAfterPayment,
        });
        if (result.changed) changed += 1;
      } catch (err) {
        errored += 1;
        logger.error("Courier payment reconcile failed for one payment", {
          jobName: "reconcilePorterPaymentsJob",
          paymentId: String(payment._id),
          error: err?.message,
        });
      }
    }

    if (stale.length) {
      logger.info("Courier payment reconciliation sweep", {
        jobName: "reconcilePorterPaymentsJob",
        checked: stale.length,
        changed,
        errored,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (err) {
    logger.error("Courier payment reconciliation sweep failed", {
      jobName: "reconcilePorterPaymentsJob",
      error: err?.message,
      stack: err?.stack,
    });
  }
};

export const getReconcilePorterPaymentsJobHandler = () => reconcile;
export const getReconcilePorterPaymentsJobInterval = () => INTERVAL_MS;
export const isReconcilePorterPaymentsJobEnabled = () =>
  process.env.PORTER_PAYMENT_RECONCILE_ENABLED !== "false";

export default reconcile;
