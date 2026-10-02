import crypto from "crypto";
import Customer from "../models/customer.js";
import { sendSmsIndiaHubOtp } from "./smsIndiaHubService.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import { incrementWindowCounter } from "../utils/otpRateLimit.js";
import { isValidE164Phone, maskPhone, normalizePhoneNumber } from "../utils/phone.js";

const OTP_EXPIRY_MINUTES = () => parseInt(process.env.OTP_EXPIRY_MINUTES || "5", 10);
// Throttling defaults are set generously so a normal deployment needs no
// OTP_* environment variables at all. They still bound abuse (this endpoint
// creates a Customer record for unknown numbers) without tripping during
// ordinary use or testing. Override via env only if you need them tighter.
const OTP_RESEND_COOLDOWN_SECONDS = () =>
  parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || "0", 10);
const OTP_MAX_FAILED_ATTEMPTS = () =>
  parseInt(process.env.OTP_MAX_ATTEMPTS || process.env.OTP_MAX_FAILED_ATTEMPTS || "5", 10);
const OTP_LOCKOUT_MINUTES = () =>
  parseInt(process.env.OTP_LOCKOUT_MINUTES || "15", 10);
// OTP_RATE_LIMIT / OTP_RATE_WINDOW are the user-facing "how many codes can
// this phone request" knob; the older *_LIMIT_PER_WINDOW / *_WINDOW_SECONDS
// names stay as fallbacks for deployments that already set those.
const OTP_SEND_LIMIT_WINDOW_SECONDS = () =>
  parseInt(
    process.env.OTP_RATE_WINDOW || process.env.OTP_SEND_LIMIT_WINDOW_SECONDS || "900",
    10,
  );
const OTP_SEND_LIMIT_PER_WINDOW = () =>
  parseInt(
    process.env.OTP_RATE_LIMIT || process.env.OTP_SEND_LIMIT_PER_WINDOW || "100",
    10,
  );
const OTP_VERIFY_LIMIT_WINDOW_SECONDS = () =>
  parseInt(process.env.OTP_VERIFY_LIMIT_WINDOW_SECONDS || "900", 10);
const OTP_VERIFY_LIMIT_PER_WINDOW = () =>
  parseInt(process.env.OTP_VERIFY_LIMIT_PER_WINDOW || "100", 10);
function otpHashSecret() {
  return process.env.OTP_HASH_SECRET || process.env.JWT_SECRET || "unsafe-dev-secret";
}

function hashOtp(phone, otp) {
  return crypto
    .createHmac("sha256", otpHashSecret())
    .update(`${phone}:${otp}`)
    .digest("hex");
}

function otpAuditLog(event, meta) {
  console.log(
    JSON.stringify({
      level: "info",
      ts: new Date().toISOString(),
      event,
      ...meta,
    }),
  );
}

async function dispatchCustomerOtpSms({ phone, otp }) {
  return sendSmsIndiaHubOtp({ phone, otp });
}


export function normalizeAndValidatePhone(rawPhone) {
  const phone = normalizePhoneNumber(rawPhone);
  if (!isValidE164Phone(phone)) {
    const err = new Error("Invalid phone number format");
    err.statusCode = 400;
    throw err;
  }
  return phone;
}

export async function issueCustomerOtp({
  name = "",
  rawPhone,
  flow,
  ipAddress = "unknown",
}) {
  const phone = normalizeAndValidatePhone(rawPhone);
  const now = new Date();

  const sendAllowed = await incrementWindowCounter(`otp:send:phone:${phone}`, {
    limit: OTP_SEND_LIMIT_PER_WINDOW(),
    windowSeconds: OTP_SEND_LIMIT_WINDOW_SECONDS(),
  });
  if (!sendAllowed) {
    const err = new Error("Too many OTP requests. Try again later.");
    err.statusCode = 429;
    throw err;
  }

  let customer = await Customer.findOne({ phone }).select(
    "+otpHash +otpExpiresAt +otpFailedAttempts +otpLockedUntil +otpLastSentAt +otpSessionVersion +otp +otpExpiry",
  );

  /**
   * Logging in requires an account to log in to.
   *
   * This previously auto-created a customer in mock mode "so local testing
   * works end-to-end", which meant any number at all could sign in — the
   * account was created by the act of trying to log in. In real-SMS mode it
   * instead returned a silent success, so an unregistered caller sat waiting
   * for an OTP that was never sent.
   *
   * Both are now a clear NOT_REGISTERED, which the app turns into an offer to
   * sign up. The trade-off is account enumeration: a caller can learn which
   * numbers are registered. That is what the per-phone and per-IP rate limits
   * on this route are for, and it is the behaviour consumer apps here expect —
   * being told to sign up beats staring at an OTP box forever.
   */
  if (flow === "login" && !customer) {
    otpAuditLog("customer_otp_login_unregistered", {
      phone: maskPhone(phone),
      ipAddress,
    });
    const err = new Error("This number is not registered");
    err.statusCode = 404;
    err.code = "NOT_REGISTERED";
    throw err;
  }

  // A deactivated account should not even receive an OTP — sending one and
  // rejecting it only at verify time wastes an SMS and confuses the caller
  // about why a code they clearly received doesn't work.
  if (flow === "login" && customer && customer.isActive === false) {
    otpAuditLog("customer_otp_login_deactivated", {
      phone: maskPhone(phone),
      ipAddress,
    });
    const err = new Error(
      "Your account has been deactivated. Please contact support for help.",
    );
    err.statusCode = 403;
    err.code = "ACCOUNT_DEACTIVATED";
    throw err;
  }

  if (!customer) {
    customer = await Customer.create({
      name: name || "Customer",
      phone,
      isVerified: false,
    });
    customer = await Customer.findById(customer._id).select(
      "+otpHash +otpExpiresAt +otpFailedAttempts +otpLockedUntil +otpLastSentAt +otpSessionVersion +otp +otpExpiry",
    );
  }

  if (customer.otpLockedUntil && customer.otpLockedUntil > now) {
    const err = new Error("OTP verification is temporarily locked for this number");
    err.statusCode = 423;
    throw err;
  }

  const lastSentAt = customer.otpLastSentAt ? new Date(customer.otpLastSentAt) : null;
  const cooldownMs = OTP_RESEND_COOLDOWN_SECONDS() * 1000;
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < cooldownMs) {
    const waitSec = Math.ceil((cooldownMs - (now.getTime() - lastSentAt.getTime())) / 1000);
    const err = new Error(`Please wait ${waitSec}s before requesting another OTP`);
    err.statusCode = 429;
    throw err;
  }

  const otp = generateOTP();
  customer.otpHash = hashOtp(phone, otp);
  customer.otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES() * 60 * 1000);
  customer.otpFailedAttempts = 0;
  customer.otpLockedUntil = null;
  customer.otpLastSentAt = now;
  customer.otpSessionVersion = (customer.otpSessionVersion || 0) + 1;

  // Backward compatibility with legacy fields; raw OTP is intentionally not stored.
  customer.otp = undefined;
  customer.otpExpiry = undefined;

  await customer.save();

  if (useRealSMS()) {
    /**
     * The account and its OTP are already saved by this point, so a courier
     * that is down or out of credit does not mean the request failed. Letting
     * the throw escape reported it as a 500 and told the customer to start
     * over, when a resend was all that was needed.
     *
     * The provider's message goes to the audit log; the caller is told the
     * code could not be delivered and that retrying is the fix.
     */
    try {
      await dispatchCustomerOtpSms({ phone, otp });
      otpAuditLog("customer_otp_sms_dispatched", {
        phone: maskPhone(phone),
        flow,
        ipAddress,
        mode: "real",
      });
    } catch (smsError) {
      otpAuditLog("customer_otp_sms_failed", {
        phone: maskPhone(phone),
        flow,
        ipAddress,
        error: smsError?.message,
      });
      const err = new Error(
        "We couldn't send your code just now. Please try again in a moment.",
      );
      err.statusCode = 502;
      err.code = "OTP_SMS_FAILED";
      throw err;
    }
  } else {
    otpAuditLog("customer_otp_mock_mode", {
      phone: maskPhone(phone),
      flow,
      ipAddress,
      mode: "mock",
    });
  }

  return { sent: true, phone };
}

export async function verifyCustomerOtpCode({
  rawPhone,
  otp,
  ipAddress = "unknown",
}) {
  const phone = normalizeAndValidatePhone(rawPhone);
  const code = String(otp || "").trim();
  if (!/^\d{4,8}$/.test(code)) {
    const err = new Error("Invalid OTP format");
    err.statusCode = 400;
    throw err;
  }

  const verifyAllowed = await incrementWindowCounter(`otp:verify:phone:${phone}`, {
    limit: OTP_VERIFY_LIMIT_PER_WINDOW(),
    windowSeconds: OTP_VERIFY_LIMIT_WINDOW_SECONDS(),
  });
  if (!verifyAllowed) {
    const err = new Error("Too many OTP verification attempts. Try again later.");
    err.statusCode = 429;
    throw err;
  }

  const customer = await Customer.findOne({ phone }).select(
    "+otpHash +otpExpiresAt +otpFailedAttempts +otpLockedUntil +otpSessionVersion +otp +otpExpiry",
  );
  if (!customer) {
    const err = new Error("Invalid or expired OTP");
    err.statusCode = 400;
    throw err;
  }

  // Covers the gap between an OTP being sent and the account being
  // deactivated in between send and verify.
  if (customer.isActive === false) {
    otpAuditLog("customer_otp_verify_deactivated", {
      phone: maskPhone(phone),
      ipAddress,
    });
    const err = new Error(
      "Your account has been deactivated. Please contact support for help.",
    );
    err.statusCode = 403;
    err.code = "ACCOUNT_DEACTIVATED";
    throw err;
  }

  const now = new Date();
  if (customer.otpLockedUntil && customer.otpLockedUntil > now) {
    const err = new Error("Too many failed attempts. Please try again later.");
    err.statusCode = 423;
    throw err;
  }

  if (!customer.otpHash || !customer.otpExpiresAt || customer.otpExpiresAt <= now) {
    const err = new Error("Invalid or expired OTP");
    err.statusCode = 400;
    throw err;
  }

  const isValid = hashOtp(phone, code) === customer.otpHash;
  if (!isValid) {
    customer.otpFailedAttempts = (customer.otpFailedAttempts || 0) + 1;

    if (customer.otpFailedAttempts >= OTP_MAX_FAILED_ATTEMPTS()) {
      customer.otpLockedUntil = new Date(
        now.getTime() + OTP_LOCKOUT_MINUTES() * 60 * 1000,
      );
    }

    await customer.save();
    otpAuditLog("customer_otp_verify_failed", {
      phone: maskPhone(phone),
      ipAddress,
      failedAttempts: customer.otpFailedAttempts,
      lockedUntil: customer.otpLockedUntil || null,
    });

    const err = new Error("Invalid or expired OTP");
    err.statusCode = customer.otpLockedUntil ? 423 : 400;
    throw err;
  }

  customer.isVerified = true;
  customer.otpHash = undefined;
  customer.otpExpiresAt = undefined;
  customer.otpFailedAttempts = 0;
  customer.otpLockedUntil = undefined;
  customer.otpSessionVersion = (customer.otpSessionVersion || 0) + 1;
  customer.otp = undefined;
  customer.otpExpiry = undefined;
  customer.lastLogin = now;

  await customer.save();

  otpAuditLog("customer_otp_verify_success", {
    phone: maskPhone(phone),
    ipAddress,
  });

  return customer;
}

export function sanitizeCustomer(customerDoc) {
  if (!customerDoc) return null;
  const obj = customerDoc.toObject ? customerDoc.toObject() : { ...customerDoc };
  delete obj.password;
  delete obj.__v;
  delete obj.updatedAt;
  delete obj.otp;
  delete obj.otpHash;
  delete obj.otpExpiry;
  delete obj.otpExpiresAt;
  delete obj.otpFailedAttempts;
  delete obj.otpLockedUntil;
  delete obj.otpLastSentAt;
  delete obj.otpSessionVersion;
  return obj;
}
