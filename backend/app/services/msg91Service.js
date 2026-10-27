import axios from "axios";
import Setting from "../models/setting.js";
import { toIndianNumber } from "../utils/smsHelpers.js";

// https://docs.msg91.com/otp/sendotp
const MSG91_OTP_URL = "https://control.msg91.com/api/v5/otp";

/** Admin-configured in Settings → SMS (no env vars — see msg91AuthKey etc. on the Setting model). */
async function getMsg91Config() {
  const settings = await Setting.findOne({}).select("msg91AuthKey msg91TemplateId").lean();
  return {
    authKey: String(settings?.msg91AuthKey || "").trim(),
    templateId: String(settings?.msg91TemplateId || "").trim(),
  };
}

export async function hasMsg91Config() {
  const { authKey, templateId } = await getMsg91Config();
  return Boolean(authKey && templateId);
}

export async function sendMsg91Otp({ phone, otp }) {
  const { authKey, templateId } = await getMsg91Config();
  if (!authKey || !templateId) {
    const error = new Error("MSG91 is not configured — set Auth Key and Template ID in Admin → Settings → SMS");
    error.statusCode = 500;
    throw error;
  }

  const { data } = await axios.post(MSG91_OTP_URL, null, {
    params: {
      template_id: templateId,
      mobile: toIndianNumber(phone),
      authkey: authKey,
      otp,
    },
    timeout: 10000,
  });

  if (data?.type !== "success") {
    const error = new Error(data?.message || "MSG91 OTP request failed");
    error.statusCode = 502;
    error.providerRaw = data;
    throw error;
  }

  return { provider: "msg91", requestId: data.message, rawResponse: data };
}
