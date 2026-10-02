import crypto from "crypto";
import Admin from "../models/admin.js";
import { sendAdminPasswordResetOtpEmail } from "./emailService.js";
import { incrementWindowCounter } from "../utils/otpRateLimit.js";
import * as logger from "./logger.js";

const OTP_EXPIRY_MINUTES = () => parseInt(process.env.OTP_EXPIRY_MINUTES || "10", 10);
const OTP_MAX_FAILED_ATTEMPTS = () =>
  parseInt(process.env.OTP_MAX_ATTEMPTS || process.env.OTP_MAX_FAILED_ATTEMPTS || "5", 10);
const OTP_LOCKOUT_MINUTES = () => parseInt(process.env.OTP_LOCKOUT_MINUTES || "15", 10);
const OTP_SEND_LIMIT_WINDOW_SECONDS = () =>
  parseInt(process.env.OTP_RATE_WINDOW || "900", 10);
const OTP_SEND_LIMIT_PER_WINDOW = () =>
  parseInt(process.env.OTP_RATE_LIMIT || "5", 10);
const RESET_TOKEN_TTL_MINUTES = 10;

function otpHashSecret() {
  return process.env.OTP_HASH_SECRET || process.env.JWT_SECRET || "unsafe-dev-secret";
}

function hashValue(email, value) {
  return crypto
    .createHmac("sha256", otpHashSecret())
    .update(`${email}:${value}`)
    .digest("hex");
}

function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits
}

function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "***";
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${"*".repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

/**
 * Step 1 — send a reset OTP to the admin's own email on file.
 *
 * Only an email that already belongs to an admin account can receive one;
 * this deliberately reveals "no admin with that email" (consistent with how
 * every other login flow in this app already treats an unregistered
 * identifier), rather than a vague "if this email exists" response.
 */
export async function issueAdminPasswordResetOtp({ email, ipAddress = "unknown" }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    const err = new Error("Enter a valid email address");
    err.statusCode = 400;
    throw err;
  }

  const sendAllowed = await incrementWindowCounter(
    `admin:pwreset:send:${normalizedEmail}`,
    { limit: OTP_SEND_LIMIT_PER_WINDOW(), windowSeconds: OTP_SEND_LIMIT_WINDOW_SECONDS() },
  );
  if (!sendAllowed) {
    const err = new Error("Too many requests. Try again later.");
    err.statusCode = 429;
    throw err;
  }

  const admin = await Admin.findOne({ email: normalizedEmail }).select(
    "+otpHash +otpExpiresAt +otpFailedAttempts +otpLockedUntil",
  );
  if (!admin) {
    const err = new Error("No admin account found with this email");
    err.statusCode = 404;
    err.code = "NOT_REGISTERED";
    throw err;
  }

  const now = new Date();
  const otp = generateOtp();
  admin.otpHash = hashValue(normalizedEmail, otp);
  admin.otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES() * 60 * 1000);
  admin.otpFailedAttempts = 0;
  admin.otpLockedUntil = undefined;
  admin.resetTokenHash = undefined;
  admin.resetTokenExpiresAt = undefined;
  await admin.save();

  try {
    await sendAdminPasswordResetOtpEmail({
      to: normalizedEmail,
      otp,
      expiresInMinutes: OTP_EXPIRY_MINUTES(),
    });
  } catch (emailError) {
    logger.error("[adminPasswordReset] OTP email failed", {
      email: maskEmail(normalizedEmail),
      error: emailError?.message,
    });
    const err = new Error(
      "We couldn't send the reset code just now. Please try again in a moment.",
    );
    err.statusCode = 502;
    err.code = "RESET_EMAIL_FAILED";
    throw err;
  }

  logger.info("[adminPasswordReset] OTP dispatched", {
    email: maskEmail(normalizedEmail),
    ipAddress,
  });

  return { sent: true, email: normalizedEmail };
}

/**
 * Step 2 — verify the OTP and issue a short-lived reset token, so the
 * "new password" step doesn't need the OTP re-entered.
 */
export async function verifyAdminPasswordResetOtp({ email, otp, ipAddress = "unknown" }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const code = String(otp || "").trim();
  if (!/^\d{4}$/.test(code)) {
    const err = new Error("Invalid OTP format");
    err.statusCode = 400;
    throw err;
  }

  const admin = await Admin.findOne({ email: normalizedEmail }).select(
    "+otpHash +otpExpiresAt +otpFailedAttempts +otpLockedUntil",
  );
  if (!admin) {
    const err = new Error("Invalid or expired OTP");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  if (admin.otpLockedUntil && admin.otpLockedUntil > now) {
    const err = new Error("Too many failed attempts. Please try again later.");
    err.statusCode = 423;
    throw err;
  }

  if (!admin.otpHash || !admin.otpExpiresAt || admin.otpExpiresAt <= now) {
    const err = new Error("Invalid or expired OTP");
    err.statusCode = 400;
    throw err;
  }

  const isValid = hashValue(normalizedEmail, code) === admin.otpHash;
  if (!isValid) {
    admin.otpFailedAttempts = (admin.otpFailedAttempts || 0) + 1;
    if (admin.otpFailedAttempts >= OTP_MAX_FAILED_ATTEMPTS()) {
      admin.otpLockedUntil = new Date(now.getTime() + OTP_LOCKOUT_MINUTES() * 60 * 1000);
    }
    await admin.save();

    const err = new Error(
      admin.otpLockedUntil ? "Too many failed attempts. Please try again later." : "Invalid or expired OTP",
    );
    err.statusCode = admin.otpLockedUntil ? 423 : 400;
    throw err;
  }

  // OTP consumed; issue the reset token for the next step.
  const resetToken = crypto.randomBytes(32).toString("hex");
  admin.resetTokenHash = hashValue(normalizedEmail, resetToken);
  admin.resetTokenExpiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  admin.otpHash = undefined;
  admin.otpExpiresAt = undefined;
  admin.otpFailedAttempts = 0;
  admin.otpLockedUntil = undefined;
  await admin.save();

  logger.info("[adminPasswordReset] OTP verified", {
    email: maskEmail(normalizedEmail),
    ipAddress,
  });

  return { resetToken };
}

/**
 * Step 3 — set the new password using the token from step 2.
 */
export async function resetAdminPassword({
  email,
  resetToken,
  newPassword,
  ipAddress = "unknown",
}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const token = String(resetToken || "").trim();
  if (!token) {
    const err = new Error("Reset session expired. Start again.");
    err.statusCode = 400;
    throw err;
  }

  const admin = await Admin.findOne({ email: normalizedEmail }).select(
    "+resetTokenHash +resetTokenExpiresAt",
  );
  if (!admin) {
    const err = new Error("Reset session expired. Start again.");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  if (
    !admin.resetTokenHash ||
    !admin.resetTokenExpiresAt ||
    admin.resetTokenExpiresAt <= now ||
    hashValue(normalizedEmail, token) !== admin.resetTokenHash
  ) {
    const err = new Error("Reset session expired. Start again.");
    err.statusCode = 400;
    throw err;
  }

  admin.password = newPassword; // hashed by the pre-save hook
  admin.resetTokenHash = undefined;
  admin.resetTokenExpiresAt = undefined;
  await admin.save();

  logger.info("[adminPasswordReset] password changed", {
    email: maskEmail(normalizedEmail),
    ipAddress,
  });

  return { success: true };
}
