import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import Seller from "../models/seller.js";
import Customer from "../models/customer.js";
import Delivery from "../models/delivery.js";

function extractJwtFromHeaders(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader) {
    const parts = authHeader.split(/\s+/);
    if (parts.length >= 2 && /^bearer$/i.test(parts[0])) {
      return parts[1];
    }

    // Allow raw JWT in Authorization header for non-standard clients.
    // Still requires signature verification so it doesn't weaken auth.
    if (authHeader.split(".").length === 3) {
      return authHeader;
    }
  }

  const xAccessToken = String(req.headers["x-access-token"] || "").trim();
  if (xAccessToken && xAccessToken.split(".").length === 3) {
    return xAccessToken;
  }

  return null;
}

/* ===============================
   Verify Token
================================ */
export const verifyToken = async (req, res, next) => {
  let decoded;
  try {
    const token = extractJwtFromHeaders(req);

    if (!token) {
      return handleResponse(res, 401, "Unauthorized, token missing");
    }

    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return handleResponse(res, 401, "Invalid or expired token");
  }

  // A customer or rider token is only good while it still matches the
  // account's session version. Logging in as the other role on the same
  // number bumps it (see services/sessionService.js).
  if (decoded.role === "customer" || decoded.role === "delivery") {
    try {
      const Model = decoded.role === "customer" ? Customer : Delivery;
      const account = await Model.findById(decoded.id).select("sessionVersion").lean();
      if (!account) {
        return handleResponse(res, 401, "Account not found");
      }
      if ((account.sessionVersion || 0) !== (decoded.sv || 0)) {
        return handleResponse(
          res,
          401,
          "You were signed out because this number logged in to another account.",
          { code: "SESSION_REPLACED" },
        );
      }
    } catch (error) {
      return handleResponse(res, 503, "Unable to validate your session, please try again");
    }
  }

  req.user = decoded; // { id, role, sv }
  next();
};

/* ===============================
   Optional Verify Token (for public routes that need user context)
================================ */
export const optionalVerifyToken = (req, res, next) => {
  try {
    const token = extractJwtFromHeaders(req);

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { id, role }
      } catch (error) {
        // Token is invalid, but we don't block the request
        req.user = null;
      }
    }

    next();
  } catch (error) {
    // Don't block the request, just continue without user
    next();
  }
};

/* ===============================
   Role Based Access
================================ */
export const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return handleResponse(res, 403, "Access denied");
    }
    next();
  };
};

/* ===============================
   Ensure seller can access seller-only operational routes
================================ */
export const requireApprovedSeller = async (req, res, next) => {
  try {
    if (req.user?.role !== "seller") {
      return next();
    }

    const seller = await Seller.findById(req.user.id)
      .select("isVerified isActive applicationStatus rejectionReason")
      .lean();

    if (!seller) {
      return handleResponse(res, 401, "Seller account not found");
    }

    const applicationStatus =
      seller.applicationStatus || (seller.isVerified ? "approved" : "pending");
    const isApproved =
      seller.isVerified === true &&
      seller.isActive === true &&
      applicationStatus === "approved";

    if (!isApproved) {
      const message =
        applicationStatus === "rejected"
          ? "Seller application rejected. Please contact admin support."
          : "Seller account is pending admin approval.";

      return handleResponse(res, 403, message, {
        applicationStatus,
        isVerified: seller.isVerified === true,
        isActive: seller.isActive === true,
        rejectionReason: seller.rejectionReason || "",
      });
    }

    next();
  } catch (error) {
    return handleResponse(res, 500, "Unable to validate seller approval status");
  }
};

/* ===============================
   Ensure a customer's JWT can't outlive an admin deactivating them.
   The token itself stays valid until it expires — this middleware is what
   actually enforces "deactivated customers can't use the app" on routes
   that carry real consequences (placing a booking, reading a live profile).
================================ */
export const requireActiveCustomer = async (req, res, next) => {
  try {
    if (req.user?.role !== "customer" && req.user?.role !== "user") {
      return next();
    }

    const customer = await Customer.findById(req.user.id).select("isActive").lean();

    if (!customer) {
      return handleResponse(res, 401, "Account not found");
    }

    if (customer.isActive === false) {
      return handleResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support for help.",
        { code: "ACCOUNT_DEACTIVATED" },
      );
    }

    next();
  } catch (error) {
    return handleResponse(res, 500, "Unable to validate account status");
  }
};

/* ===============================
   Ensure a delivery partner's JWT can't outlive an admin deactivating them.
   Same idea and same contract as requireActiveCustomer above — the token
   stays valid until it expires, this is what actually blocks every
   authenticated action once an admin flips isActive off.
================================ */
export const requireActiveDelivery = async (req, res, next) => {
  try {
    if (req.user?.role !== "delivery") {
      return next();
    }

    const delivery = await Delivery.findById(req.user.id).select("isActive").lean();

    if (!delivery) {
      return handleResponse(res, 401, "Account not found");
    }

    if (delivery.isActive === false) {
      return handleResponse(
        res,
        403,
        "Your account has been deactivated by admin. Please contact support for help.",
        { code: "ACCOUNT_DEACTIVATED" },
      );
    }

    next();
  } catch (error) {
    return handleResponse(res, 500, "Unable to validate account status");
  }
};
