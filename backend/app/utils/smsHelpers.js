import crypto from "crypto";

const DEFAULT_OTP_LENGTH = 4;

export function normalizeMobile(mobile) {
  return String(mobile || "").replace(/\D/g, "").slice(-10);
}

export function toIndianNumber(mobile) {
  const normalized = normalizeMobile(mobile);
  return normalized ? `91${normalized}` : "";
}

export function getOtpLength() {
  const parsed = parseInt(process.env.OTP_LENGTH || `${DEFAULT_OTP_LENGTH}`, 10);
  return Number.isFinite(parsed) && parsed >= 4 ? parsed : DEFAULT_OTP_LENGTH;
}

export function generateOTP(length = getOtpLength()) {
  const safeLength = Math.max(4, Number(length || DEFAULT_OTP_LENGTH));
  const min = 10 ** (safeLength - 1);
  const max = 10 ** safeLength;
  return crypto.randomInt(min, max).toString();
}

