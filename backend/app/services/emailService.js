import nodemailer from "nodemailer";
import logger from "./logger.js";

/**
 * Single mail transport for every outbound email this app sends — seller
 * signup verification and the admin "forgot password" OTP. One mailbox
 * (EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS/EMAIL_FROM), one transporter,
 * reused by both callers instead of each feature carrying its own SMTP
 * config.
 */

let cachedTransporter = null;

export function useRealEmailOTP() {
  return (
    process.env.USE_REAL_EMAIL_OTP === "true" ||
    process.env.USE_REAL_EMAIL_OTP === "1"
  );
}

function parseEmailPort() {
  return parseInt(process.env.EMAIL_PORT || "587", 10);
}

function getMailFrom() {
  const from = String(process.env.EMAIL_FROM || "").trim();
  if (from) return from;

  const user = String(process.env.EMAIL_USER || "").trim();
  if (!user) {
    const error = new Error("EMAIL_FROM or EMAIL_USER is required for email delivery");
    error.statusCode = 500;
    throw error;
  }
  return user;
}

function getTransportConfig() {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = parseEmailPort();
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();

  if (!host) {
    const error = new Error("EMAIL_HOST is required for email delivery");
    error.statusCode = 500;
    throw error;
  }

  if (!Number.isFinite(port) || port <= 0) {
    const error = new Error("EMAIL_PORT must be a valid number");
    error.statusCode = 500;
    throw error;
  }

  if ((user && !pass) || (!user && pass)) {
    const error = new Error("EMAIL_USER and EMAIL_PASS must be provided together");
    error.statusCode = 500;
    throw error;
  }

  return {
    host,
    port,
    secure: port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}

function getTransporter() {
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport(getTransportConfig());
  }

  return cachedTransporter;
}

export async function sendSellerVerificationOtpEmail({
  email,
  otp,
  expiresInMinutes,
}) {
  if (!useRealEmailOTP()) {
    logger.info("Seller email OTP generated in mock mode", {
      email,
      otp,
      mode: "mock",
    });
    return {
      delivered: false,
      mode: "mock",
    };
  }

  const transporter = getTransporter();
  await transporter.sendMail({
    from: getMailFrom(),
    to: email,
    subject: "Verify your seller signup email",
    text: `Your seller signup verification code is ${otp}. This code expires in ${expiresInMinutes} minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Your seller signup verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px;">${otp}</p>
        <p>This code expires in ${expiresInMinutes} minutes.</p>
      </div>
    `,
  });

  return {
    delivered: true,
    mode: "real",
  };
}

export async function sendAdminPasswordResetOtpEmail({ to, otp, expiresInMinutes }) {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject: "Your admin password reset code",
    text: `Your password reset code is ${otp}. This code expires in ${expiresInMinutes} minutes. If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <p>Your admin password reset code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px;">${otp}</p>
        <p>This code expires in ${expiresInMinutes} minutes.</p>
        <p style="color: #64748b; font-size: 13px;">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

/**
 * A general-purpose send through the same mailbox and transporter — used by
 * emails that carry their own subject, body and attachments (the delivered
 * invoice). Throws if the mail transport is not configured or the send fails;
 * callers that must never fail their own flow catch it.
 */
export async function sendEmail({ to, subject, text, html, attachments = [] }) {
  const transporter = getTransporter();
  return transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    text,
    html,
    ...(attachments.length ? { attachments } : {}),
  });
}

export function __resetEmailTransportForTests() {
  cachedTransporter = null;
}
