import Razorpay from "razorpay";

/**
 * On-the-spot UPI QR for a booking that was placed as COD.
 *
 * The customer books cash-on-pickup, then at the door decides to pay
 * digitally instead. Rather than the rider taking cash and later depositing
 * it, this puts the money straight into the platform's Razorpay account: the
 * rider shows a QR, the customer scans it with their own UPI app, and the
 * booking stops being COD altogether.
 *
 * Razorpay's QR Codes API is used rather than a payment link because it hands
 * back a hosted `image_url` — no QR rendering library is needed in the rider
 * app, and the customer never has to touch the rider's phone.
 *
 * There is no Razorpay webhook configured in this project, so payment is
 * confirmed by reading the QR back (`fetchCodQrStatus`). Callers should poll
 * gently and stop as soon as it reports paid.
 */

function requireRazorpayConfig() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!keyId || !keySecret) {
    const err = new Error("Online payment is not configured right now");
    err.statusCode = 503;
    throw err;
  }
  return { keyId, keySecret };
}

function getClient() {
  const { keyId, keySecret } = requireRazorpayConfig();
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export function isCodQrAvailable() {
  return Boolean(
    String(process.env.RAZORPAY_KEY_ID || "").trim() &&
      String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
  );
}

function toPaise(amount) {
  const rupees = Number(amount);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    const err = new Error("Invalid amount for payment");
    err.statusCode = 400;
    throw err;
  }
  return Math.round(rupees * 100);
}

function formatRazorpayError(err) {
  const description =
    err?.error?.description ||
    err?.error?.reason ||
    err?.description ||
    err?.message ||
    "Could not create the payment QR";
  const rawStatus =
    Number(err?.statusCode || err?.status || err?.error?.http_status_code) || 500;

  /**
   * A 401/403 here means Razorpay rejected OUR api key/secret — not anything
   * about the rider's session. Our own API already uses 401/403 for exactly
   * "your JWT is missing/invalid/not your role", and app clients treat those
   * codes as a signal to clear the stored token and log out. Forwarding a
   * gateway credential failure as a 401 was doing exactly that: a bad/expired
   * Razorpay key logged every rider out mid-shift, including on calls that
   * had nothing to do with payment. Remapped to 502 (upstream failure) so a
   * gateway misconfiguration can never masquerade as the caller's own auth
   * failing.
   */
  const statusCode =
    rawStatus === 401 || rawStatus === 403
      ? 502
      : rawStatus >= 400 && rawStatus < 600
        ? rawStatus
        : 500;
  const out = new Error(description);
  out.statusCode = statusCode;
  return out;
}

/** How long a QR stays scannable. Long enough for a doorstep, not all day. */
const QR_TTL_MINUTES = 30;

/**
 * Single-use, fixed-amount UPI QR for exactly this booking's fare.
 *
 * @returns {{ qrId, imageUrl, amount, closeBy }}
 */
export async function createCodQr({ amount, label, notes = {} }) {
  const client = getClient();
  const paise = toPaise(amount);
  const closeBy = Math.floor(Date.now() / 1000) + QR_TTL_MINUTES * 60;

  try {
    const qr = await client.qrCode.create({
      type: "upi_qr",
      name: String(label || "Delivery payment").slice(0, 60),
      usage: "single_use",
      fixed_amount: true,
      payment_amount: paise,
      description: String(label || "Delivery payment").slice(0, 120),
      close_by: closeBy,
      notes,
    });

    return {
      qrId: qr.id,
      imageUrl: qr.image_url,
      amount: paise,
      closeBy: new Date(closeBy * 1000),
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/**
 * Has this QR been paid?
 *
 * Razorpay reports `payments_amount_received` in paise on the QR itself, so
 * one read answers it without listing payments.
 *
 * @returns {{ paid, amountReceived, status, paymentId }}
 */
export async function fetchCodQrStatus(qrId, expectedPaise) {
  if (!qrId) {
    const err = new Error("No payment QR to check");
    err.statusCode = 400;
    throw err;
  }

  const client = getClient();
  try {
    const qr = await client.qrCode.fetch(qrId);
    const received = Number(qr?.payments_amount_received || 0);
    const paid = expectedPaise ? received >= Number(expectedPaise) : received > 0;

    let paymentId = null;
    if (paid) {
      // Only reached once, at the moment it flips to paid — the id is stored
      // on the booking so this never has to run again.
      try {
        const payments = await client.qrCode.fetchAllPayments(qrId, { count: 1 });
        paymentId = payments?.items?.[0]?.id || null;
      } catch {
        /* the payment is confirmed either way; the id is a nicety */
      }
    }

    return {
      paid,
      amountReceived: received,
      status: qr?.status || "active",
      paymentId,
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/** Closes a QR so it cannot be scanned again. Failure here is not fatal. */
export async function closeCodQr(qrId) {
  if (!qrId) return null;
  try {
    return await getClient().qrCode.close(qrId);
  } catch {
    return null;
  }
}
