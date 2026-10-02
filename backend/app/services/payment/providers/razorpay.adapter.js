/**
 * RazorpayAdapter
 *
 * Single home for the Razorpay SDK on the order-payment path. `paymentService`
 * only ever sees this through `PaymentProviderPort`, so nothing in the domain
 * imports a vendor SDK.
 *
 * Razorpay is an order + checkout gateway, not a redirect one: the server
 * opens an order, the client launches checkout against it, and the client
 * hands back a receipt signed with the key secret. That receipt is checked
 * here (`verifyCheckoutSignature`) and, independently, a server-to-server
 * webhook confirms the same payment — so a customer who closes the browser
 * mid-payment still gets their order confirmed.
 *
 * The two signatures are different and must not be confused:
 *   checkout receipt → HMAC_SHA256(`${order_id}|${payment_id}`, key_secret)
 *   webhook          → HMAC_SHA256(raw request body, webhook_secret)
 */

import crypto from "crypto";
import Razorpay from "razorpay";

import { PAYMENT_STATUS, PAYMENT_GATEWAY } from "../../../constants/payment.js";
import { PaymentProviderPort } from "../ports/paymentProviderPort.js";

let _client = null;
let _clientKeyId = null;

function readCredentials() {
  return {
    keyId: String(process.env.RAZORPAY_KEY_ID || "").trim(),
    keySecret: String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
  };
}

function requireCredentials() {
  const { keyId, keySecret } = readCredentials();
  if (!keyId || !keySecret) {
    const err = new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
    );
    err.statusCode = 503;
    throw err;
  }
  return { keyId, keySecret };
}

/** Rebuilt when the key changes, so a test can swap credentials. */
function getClient() {
  const { keyId, keySecret } = requireCredentials();
  if (_client && _clientKeyId === keyId) return _client;
  _client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  _clientKeyId = keyId;
  return _client;
}

/** Compares without leaking how much of the digest matched. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Razorpay reports the payment, not the order, as the thing that succeeded.
 * `captured` is money actually taken; `authorized` is money held but not yet
 * taken, which on an auto-capture account resolves to captured moments later.
 */
function mapPaymentState(state) {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "captured") return PAYMENT_STATUS.CAPTURED;
  if (normalized === "authorized") return PAYMENT_STATUS.AUTHORIZED;
  if (normalized === "failed") return PAYMENT_STATUS.FAILED;
  if (normalized === "refunded") return PAYMENT_STATUS.REFUNDED;
  // "created" and anything unrecognised: still in flight.
  return PAYMENT_STATUS.PENDING;
}

/**
 * Turns an SDK rejection into something with a usable status code.
 *
 * A 401/403 from Razorpay means our own API key/secret was rejected, not
 * anything about the caller's session — but 401/403 are exactly the codes
 * this app's own clients treat as "your login is invalid, log out." Passing
 * a gateway credential failure straight through as 401 does that for real,
 * to a customer or rider who did nothing wrong. Remapped to 502 so a bad or
 * rotated Razorpay key can never trigger a client-side logout.
 */
function toHttpError(err, fallback = "Payment gateway request failed") {
  const description =
    err?.error?.description || err?.description || err?.message || fallback;
  const rawStatus =
    Number(err?.statusCode || err?.error?.http_status_code || err?.status) || 502;
  const status = rawStatus === 401 || rawStatus === 403 ? 502 : rawStatus;
  const out = new Error(description);
  out.statusCode = status >= 400 && status < 600 ? status : 502;
  return out;
}

export class RazorpayAdapter extends PaymentProviderPort {
  get providerName() {
    return PAYMENT_GATEWAY.RAZORPAY;
  }

  /** False when credentials are absent, so callers can offer COD instead. */
  isConfigured() {
    const { keyId, keySecret } = readCredentials();
    return Boolean(keyId && keySecret);
  }

  /**
   * Opens a Razorpay order.
   *
   * `receipt` carries our own merchant order id so a payment can be traced
   * back from the Razorpay dashboard without a database lookup, and `notes`
   * repeats it because webhook payloads echo notes but not always receipts.
   */
  async initiatePayment({ merchantOrderId, amountPaise, currency = "INR", notes = {} }) {
    const client = getClient();
    const { keyId } = requireCredentials();

    const amount = Math.round(Number(amountPaise));
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error("Invalid payment amount");
      err.statusCode = 400;
      throw err;
    }

    try {
      const order = await client.orders.create({
        amount,
        currency,
        // Razorpay caps this at 40 characters.
        receipt: String(merchantOrderId).slice(0, 40),
        notes: { ...notes, merchantOrderId: String(merchantOrderId) },
      });

      return {
        // What the client needs to launch checkout. There is no redirect URL
        // in this flow — the gateway opens in a modal over our own page.
        checkout: {
          orderId: order.id,
          keyId,
          amount: order.amount,
          currency: order.currency,
        },
        gatewayOrderId: order.id,
        gatewayResponse: order,
      };
    } catch (err) {
      throw toHttpError(err, "Could not start the payment");
    }
  }

  /**
   * Authoritative status, read back from Razorpay rather than trusted from
   * the client. Looks at the payments made against the order, because an
   * order stays "created" until one of its payments is captured.
   */
  async getPaymentStatus({ gatewayOrderId }) {
    if (!gatewayOrderId) {
      const err = new Error("No gateway order to check");
      err.statusCode = 400;
      throw err;
    }

    const client = getClient();
    try {
      const list = await client.orders.fetchPayments(gatewayOrderId);
      const payments = Array.isArray(list?.items) ? list.items : [];

      // A customer may fail once and retry; the successful attempt is the
      // one that decides the order, so it wins over any earlier failure.
      const decisive =
        payments.find((p) => p.status === "captured") ||
        payments.find((p) => p.status === "authorized") ||
        payments.find((p) => p.status === "refunded") ||
        payments[payments.length - 1] ||
        null;

      return {
        state: decisive?.status || "created",
        transactionId: decisive?.id || null,
        responseCode: decisive?.error_reason || decisive?.status || null,
        gatewayResponse: { orderId: gatewayOrderId, payments },
      };
    } catch (err) {
      throw toHttpError(err, "Could not read the payment status");
    }
  }

  /**
   * The receipt Razorpay checkout hands the browser.
   *
   * Signed with the key secret, so a client cannot forge one. This proves the
   * payment id belongs to the order id; it does not prove the money was
   * captured, which is why the caller still reads the status back.
   */
  verifyCheckoutSignature({ gatewayOrderId, gatewayPaymentId, signature }) {
    const { keySecret } = requireCredentials();
    if (!gatewayOrderId || !gatewayPaymentId || !signature) return false;

    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest("hex");

    return safeEqual(expected, signature);
  }

  /**
   * Server-to-server webhook signature.
   *
   * Computed over the EXACT bytes Razorpay sent — re-serialising the parsed
   * JSON would change key order or spacing and never match, which is why the
   * route mounts a raw body parser for this path only.
   *
   * Signed with the webhook secret from the Razorpay dashboard, which is a
   * different secret from the API key. With none configured this returns
   * false rather than passing, so a misconfigured deploy refuses webhooks
   * instead of trusting anything that arrives.
   */
  async validateWebhook({ rawBody, signature }) {
    const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
    if (!secret) return false;
    if (!signature) return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
    if (!body.length) return false;

    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    return safeEqual(expected, signature);
  }

  /**
   * Flattens a Razorpay webhook into the shape `paymentService` works in.
   *
   * `event.id` is Razorpay's own idempotency handle and is stable across
   * redeliveries of the same event, which is exactly what the
   * `PaymentWebhookEvent` unique index needs to collapse retries.
   */
  async decodeWebhookPayload({ rawBody }) {
    let event;
    try {
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
      event = JSON.parse(text);
    } catch {
      const err = new Error("Webhook body must be JSON");
      err.statusCode = 400;
      throw err;
    }

    const payment = event?.payload?.payment?.entity || null;
    const order = event?.payload?.order?.entity || null;

    const gatewayOrderId = payment?.order_id || order?.id || null;
    // Our own id, echoed back through notes (set in initiatePayment) or the
    // order receipt. Either is enough to find the Payment row.
    const merchantOrderId =
      payment?.notes?.merchantOrderId ||
      order?.notes?.merchantOrderId ||
      order?.receipt ||
      null;

    // `event.id` is absent on some replayed test payloads; falling back to a
    // hash of the identity tuple keeps deduplication working rather than
    // letting a random id defeat the unique index.
    const eventId =
      event?.id ||
      crypto
        .createHash("sha256")
        .update(`${event?.event || ""}|${gatewayOrderId || ""}|${payment?.id || ""}`)
        .digest("hex");

    return {
      eventId,
      eventType: event?.event || "unknown",
      merchantOrderId,
      gatewayOrderId,
      state: payment?.status || order?.status || "created",
      transactionId: payment?.id || null,
      responseCode: payment?.error_reason || payment?.error_code || null,
      amountPaise: Number(payment?.amount ?? order?.amount ?? 0) || 0,
      raw: event,
    };
  }

  mapStatusToInternal(gatewayState) {
    return mapPaymentState(gatewayState);
  }

  /**
   * Refund a captured payment.
   *
   * `speed: "optimum"` lets Razorpay pick instant refund when the instrument
   * supports it and fall back to the normal 5-7 day cycle otherwise — the
   * merchant balance is debited immediately in both cases, only the time it
   * takes to reach the customer's account differs. A refund is requested
   * against the PAYMENT id, not the order id: an order can carry more than
   * one payment attempt, and only the one that actually captured has money to
   * give back.
   */
  async initiateRefund({ gatewayPaymentId, amountPaise, notes = {}, receipt = null }) {
    if (!gatewayPaymentId) {
      const err = new Error("No gateway payment to refund");
      err.statusCode = 400;
      throw err;
    }

    const amount = Math.round(Number(amountPaise));
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error("Invalid refund amount");
      err.statusCode = 400;
      throw err;
    }

    const client = getClient();
    try {
      const refund = await client.payments.refund(gatewayPaymentId, {
        amount,
        speed: "optimum",
        notes,
        ...(receipt ? { receipt: String(receipt).slice(0, 40) } : {}),
      });

      return {
        gatewayRefundId: refund.id,
        // Razorpay returns "processed" for an instant refund and "pending"
        // for one still queued — never "failed" synchronously; a refund that
        // cannot ultimately be completed arrives later as a webhook.
        status: refund.status || "pending",
        speed: refund.speed_processed || refund.speed_requested || "",
        amount: refund.amount,
        gatewayResponse: refund,
      };
    } catch (err) {
      throw toHttpError(err, "Could not initiate the refund");
    }
  }
}

export default RazorpayAdapter;
