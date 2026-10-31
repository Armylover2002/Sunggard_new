import { hasMsg91Config } from "../services/msg91Service.js";

const MOCK_OTP = "1234";

/**
 * The single switch for the entire OTP system (customer + delivery login).
 *
 *   USE_DEFAULT_OTP=true (or unset)   every OTP is the fixed MOCK_OTP ("1234")
 *                                     and no SMS is sent. Works with zero
 *                                     configuration, in every environment
 *                                     including production.
 *   USE_DEFAULT_OTP=false             random OTPs delivered over real SMS via
 *                                     MSG91. Requires Auth Key + Template ID
 *                                     to be set in Admin → Settings → SMS.
 *
 * `USE_REAL_SMS` is kept as a fallback for older deployments that set it
 * directly, but `USE_DEFAULT_OTP` wins whenever it's present.
 *
 * Mock mode is deliberately permitted in production: it is how this deployment
 * runs before launch. If real SMS is requested but MSG91 isn't configured yet,
 * this stays in mock mode instead of breaking every login — flip
 * USE_DEFAULT_OTP to false once the admin has saved the MSG91 keys.
 */
export const useRealSMS = async () => {
  const defaultOtpSet =
    process.env.USE_DEFAULT_OTP !== undefined && process.env.USE_DEFAULT_OTP !== "";
  const wantsRealSms = defaultOtpSet
    ? !(process.env.USE_DEFAULT_OTP === "true" || process.env.USE_DEFAULT_OTP === "1")
    : process.env.USE_REAL_SMS === "true" || process.env.USE_REAL_SMS === "1";

  return wantsRealSms && (await hasMsg91Config());
};

const OTP_LENGTH = Math.max(4, parseInt(process.env.OTP_LENGTH || "4", 10));

function randomOtp(length) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

/**
 * Test accounts that always log in with MOCK_OTP and never get an SMS, even
 * when real SMS is on (customer 7878787878, driver 8787878787 — QA / app-store
 * review). Matched on the last 10 digits so "+91…" and bare numbers both hit.
 */
const STATIC_OTP_PHONES = new Set(["7878787878", "8787878787"]);
export const isStaticOtpPhone = (phone) =>
  STATIC_OTP_PHONES.has(String(phone || "").replace(/\D/g, "").slice(-10));

export const generateOTP = async (phone) =>
  !isStaticOtpPhone(phone) && (await useRealSMS()) ? randomOtp(OTP_LENGTH) : MOCK_OTP;

/**
 * 4-digit parcel pickup OTP shown on the customer app.
 * When USE_REAL_SMS is off, returns the fixed mock value so the rider can
 * always advance the booking with 1234 (Porter pre-launch flow).
 */
export const generateParcelOtp = async () => ((await useRealSMS()) ? randomOtp(4) : MOCK_OTP);

export { MOCK_OTP };
