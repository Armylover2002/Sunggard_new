import crypto from "crypto";
import Razorpay from "razorpay";

function requireRazorpayConfig() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!keyId || !keySecret) {
    const err = new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    err.statusCode = 503;
    throw err;
  }
  return { keyId, keySecret };
}

function getRazorpayClient() {
  const { keyId, keySecret } = requireRazorpayConfig();
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/** Amount in paise for Razorpay (₹1 = 100). */
export function fareToPaise(fare) {
  const rupees = Number(fare);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    const err = new Error("Invalid courier fare for payment");
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
    "Failed to start Razorpay payment";
  const rawStatus =
    Number(err?.statusCode || err?.status || err?.error?.http_status_code) || 500;
  // A 401/403 from Razorpay means our own key/secret was rejected, not the
  // caller's session — never forward that as our own 401/403, or a bad
  // gateway key looks like the customer's login failing and logs them out.
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
 * Create a Razorpay order for a parcel UPI payment.
 * @returns {{ keyId, orderId, amount, currency, receipt }}
 */
export async function createParcelRazorpayOrder(parcel) {
  const { keyId } = requireRazorpayConfig();
  const client = getRazorpayClient();
  const amount = fareToPaise(parcel.fare);
  // Razorpay receipt max length is 40; keep unique per attempt.
  const receipt = `pcl_${String(parcel._id).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40);

  try {
    const order = await client.orders.create({
      amount,
      currency: "INR",
      receipt,
      notes: {
        parcelId: String(parcel._id),
        customerId: String(parcel.customerId),
        purpose: "parcel_delivery",
      },
    });

    return {
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      receipt,
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/**
 * Create a Razorpay order for seller remitting COD cash to admin.
 */
export async function createParcelCodRemitRazorpayOrder(parcel, sellerId) {
  const { keyId } = requireRazorpayConfig();
  const client = getRazorpayClient();
  const amount = fareToPaise(parcel.codSettlement?.collectAmount || parcel.fare);
  const receipt = `cod_${String(parcel._id).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40);

  try {
    const order = await client.orders.create({
      amount,
      currency: "INR",
      receipt,
      notes: {
        parcelId: String(parcel._id),
        sellerId: String(sellerId),
        purpose: "parcel_cod_remit_to_admin",
      },
    });

    return {
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      receipt,
    };
  } catch (err) {
    throw formatRazorpayError(err);
  }
}

/**
 * Verify Razorpay checkout signature for a parcel payment.
 */
export function verifyParcelRazorpaySignature({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) {
  const { keySecret } = requireRazorpayConfig();
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    const err = new Error("Missing Razorpay payment details");
    err.statusCode = 400;
    throw err;
  }

  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(razorpaySignature), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error("Invalid Razorpay payment signature");
    err.statusCode = 400;
    throw err;
  }

  return true;
}
