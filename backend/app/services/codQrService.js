import Razorpay from "razorpay";
import QRCode from "qrcode";

/**
 * On-the-spot online payment for a booking that was placed as COD.
 *
 * The customer books cash-on-pickup, then at the door decides to pay
 * digitally instead. Rather than the rider taking cash and later depositing
 * it, this puts the money straight into the platform's Razorpay account: the
 * rider shows a QR, the customer scans it, and the booking stops being COD
 * altogether.
 *
 * Built on a Razorpay Payment Link rather than Razorpay's own UPI QR Code
 * entity: a Payment Link's `short_url` is a plain https:// address, so
 * *any* camera or QR scanner (Google Lens included) reads it as a tappable
 * link that opens Razorpay's hosted checkout — cards, netbanking and UPI are
 * all offered there. Razorpay's `upi_qr` type encodes a `upi://pay?...` deep
 * link instead, which only a UPI app's own scanner resolves; a generic
 * camera just shows the raw intent string as text, which is exactly what
 * looked broken to a rider scanning it with Lens. The QR image shown here is
 * one we render ourselves (`qrcode` package) from the link's own URL, so
 * scanning it always lands on the same page tapping it would.
 *
 * There is no Razorpay webhook configured in this project, so payment is
 * confirmed by reading the link back (`fetchCodPaymentLinkStatus`). Callers
 * should poll gently and stop as soon as it reports paid.
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
    "Could not create the payment link";
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

/**
 * A scannable PNG (data URI) of a URL — rendered locally, not fetched from
 * Razorpay, so it's just a picture of the same link the "pay by link" button
 * already uses. Failure here is never fatal: the link itself still works.
 */
async function renderLinkQrImage(url) {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 280 });
  } catch {
    return null;
  }
}

/**
 * Razorpay Payment Link + a QR of its own URL, for exactly this booking's
 * fare. `short_url` opens Razorpay's hosted checkout (UPI, cards,
 * netbanking); the QR is a picture of that same link, so scanning it with
 * any camera does the same thing as tapping it.
 *
 * @returns {{ paymentLinkId, paymentLinkUrl, imageUrl, amount }}
 */
export async function createCodPaymentLink({ amount, label, notes = {} }) {
  const client = getClient();
  const paise = toPaise(amount);

  try {
    const link = await client.paymentLink.create({
      amount: paise,
      currency: "INR",
      accept_partial: false,
      description: String(label || "Delivery payment").slice(0, 120),
      notes,
      reminder_enable: false,
    });

    return {
      paymentLinkId: link.id,
      paymentLinkUrl: link.short_url,
      imageUrl: await renderLinkQrImage(link.short_url),
      amount: paise,
      status: link.status,
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/**
 * Has this payment link been paid?
 *
 * @returns {{ paid, status, paymentId }}
 */
export async function fetchCodPaymentLinkStatus(paymentLinkId) {
  if (!paymentLinkId) {
    const err = new Error("No payment link to check");
    err.statusCode = 400;
    throw err;
  }

  const client = getClient();
  try {
    const link = await client.paymentLink.fetch(paymentLinkId);
    const paidEntry = (link?.payments || []).find((p) => p.status === "captured");

    return {
      paid: link?.status === "paid",
      status: link?.status || "created",
      paymentId: paidEntry?.payment_id || null,
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/** Cancels a link so it cannot be paid again. Failure here is not fatal. */
export async function cancelCodPaymentLink(paymentLinkId) {
  if (!paymentLinkId) return null;
  try {
    return await getClient().paymentLink.cancel(paymentLinkId);
  } catch {
    return null;
  }
}
