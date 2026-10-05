import { openRazorpayCheckout } from "@shared/utils/razorpayCheckout";

/**
 * Open Razorpay checkout for a parcel UPI payment.
 *
 * The script loading and promise handling now live in
 * `shared/utils/razorpayCheckout.js`, because the rider app takes payments too
 * (cash deposits) and reaching into the customer module for a launcher would
 * have made one feature module depend on another for no reason.
 *
 * Kept as a named export so the existing call sites — and the city-parcel and
 * order helpers that delegate to it — need no change.
 *
 * Resolves with { razorpay_order_id, razorpay_payment_id, razorpay_signature }.
 */
export async function openParcelRazorpayCheckout({
  keyId,
  orderId,
  amount,
  currency = "INR",
  name = "Courier Delivery",
  description = "Courier delivery payment",
  prefill = {},
}) {
  return openRazorpayCheckout({
    keyId,
    orderId,
    amount,
    currency,
    name,
    description,
    prefill,
  });
}

export default openParcelRazorpayCheckout;
