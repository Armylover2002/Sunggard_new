import express from "express";
import {
  handleGatewayWebhook,
} from "../controller/paymentController.js";

const paymentRoute = express.Router();

/**
 * Razorpay server-to-server webhook.
 *
 * No session auth — a gateway cannot carry one. Trust comes from the HMAC
 * over the raw body, so this path parses the body as a Buffer: re-serialising
 * parsed JSON would change byte order or spacing and the signature would
 * never match.
 *
 * Deliberately not rate-limited. Dropping a webhook loses a payment
 * confirmation, and the gateway's own retry policy is the backstop.
 */
paymentRoute.post(
  "/webhook/razorpay",
  express.raw({ type: "application/json" }),
  handleGatewayWebhook,
);

export default paymentRoute;
