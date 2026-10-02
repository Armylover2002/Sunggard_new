import Admin from "../models/admin.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import {
  bootstrapAdminSchema,
  loginAdminSchema,
  forgotPasswordSendOtpSchema,
  forgotPasswordVerifyOtpSchema,
  resetAdminPasswordSchema,
  validateSchema,
} from "../validation/adminAuthValidation.js";
import {
  issueAdminPasswordResetOtp,
  verifyAdminPasswordResetOtp,
  resetAdminPassword,
} from "../services/adminPasswordResetService.js";

function sanitizeAdmin(adminDoc) {
  const admin = adminDoc?.toObject ? adminDoc.toObject() : { ...(adminDoc || {}) };
  delete admin.password;
  delete admin.__v;
  return admin;
}

const generateToken = (admin) =>
  jwt.sign(
    { id: admin._id, role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

function readBootstrapSecret(req) {
  return String(
    req.headers["x-admin-bootstrap-secret"] ||
      req.body?.adminSecret ||
      "",
  ).trim();
}

export const bootstrapAdmin = async (req, res) => {
  try {
    const configuredSecret = String(process.env.ADMIN_BOOTSTRAP_SECRET || "").trim();
    if (!configuredSecret) {
      return handleResponse(res, 503, "Admin bootstrap is not configured");
    }

    const suppliedSecret = readBootstrapSecret(req);
    if (!suppliedSecret || suppliedSecret !== configuredSecret) {
      return handleResponse(res, 403, "Invalid admin bootstrap secret");
    }

    const existingCount = await Admin.countDocuments({});
    if (existingCount > 0) {
      return handleResponse(res, 409, "Admin bootstrap is disabled after initial setup");
    }

    const payload = validateSchema(bootstrapAdminSchema, req.body || {});
    const duplicate = await Admin.findOne({ email: payload.email }).lean();
    if (duplicate) {
      return handleResponse(res, 409, "Admin already exists");
    }

    const admin = await Admin.create({
      name: payload.name,
      email: payload.email,
      password: payload.password,
      role: "admin",
      isVerified: true,
    });

    const token = generateToken(admin);
    return handleResponse(res, 201, "Admin bootstrapped successfully", {
      token,
      admin: sanitizeAdmin(admin),
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const loginAdmin = async (req, res) => {
  try {
    const payload = validateSchema(loginAdminSchema, req.body || {});

    const admin = await Admin.findOne({ email: payload.email }).select("+password");
    if (!admin) {
      return handleResponse(res, 401, "Invalid credentials");
    }

    const isMatch = await admin.comparePassword(payload.password);
    if (!isMatch) {
      return handleResponse(res, 401, "Invalid credentials");
    }

    admin.lastLogin = new Date();
    await admin.save();

    const token = generateToken(admin);
    return handleResponse(res, 200, "Login successful", {
      token,
      admin: sanitizeAdmin(admin),
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ===============================
   FORGOT PASSWORD — 3-step flow
   1) email -> OTP sent to that email (only if it belongs to an admin)
   2) email + otp -> short-lived resetToken
   3) email + resetToken + newPassword -> password changed
================================ */

export const forgotPasswordSendOtp = async (req, res) => {
  try {
    const payload = validateSchema(forgotPasswordSendOtpSchema, req.body || {});
    const result = await issueAdminPasswordResetOtp({
      email: payload.email,
      ipAddress: req.ip,
    });
    return handleResponse(res, 200, "Reset code sent to your email", result);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message, {
      code: error.code,
    });
  }
};

export const forgotPasswordVerifyOtp = async (req, res) => {
  try {
    const payload = validateSchema(forgotPasswordVerifyOtpSchema, req.body || {});
    const result = await verifyAdminPasswordResetOtp({
      email: payload.email,
      otp: payload.otp,
      ipAddress: req.ip,
    });
    return handleResponse(res, 200, "Code verified", result);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message, {
      code: error.code,
    });
  }
};

export const resetAdminPasswordController = async (req, res) => {
  try {
    const payload = validateSchema(resetAdminPasswordSchema, req.body || {});
    const result = await resetAdminPassword({
      email: payload.email,
      resetToken: payload.resetToken,
      newPassword: payload.newPassword,
      ipAddress: req.ip,
    });
    return handleResponse(res, 200, "Password changed successfully", result);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message, {
      code: error.code,
    });
  }
};
