import express from "express";
import {
    signupCustomer,
    loginCustomer,
    verifyCustomerOTP,
    getCustomerProfile,
    updateCustomerProfile,
    getCustomerTransactions,
} from "../controller/customerAuthController.js";
import {
    getWalletSummary,
    createWalletTopup,
    verifyWalletTopup,
} from "../controller/customerWalletController.js";
import { verifyToken, requireActiveCustomer } from "../middleware/authMiddleware.js";
import {
    authRouteRateLimiter,
    createContentLengthGuard,
    otpRouteRateLimiter,
} from "../middleware/securityMiddlewares.js";

const router = express.Router();
const smallAuthPayload = createContentLengthGuard(
    parseInt(process.env.AUTH_MAX_PAYLOAD_BYTES || "16384", 10),
    "Auth payload too large",
);
router.post("/send-signup-otp", authRouteRateLimiter, otpRouteRateLimiter, smallAuthPayload, signupCustomer);
router.post("/send-login-otp", authRouteRateLimiter, otpRouteRateLimiter, smallAuthPayload, loginCustomer);
router.post("/verify-otp", authRouteRateLimiter, otpRouteRateLimiter, smallAuthPayload, verifyCustomerOTP);

// Profile routes
router.get("/profile", verifyToken, requireActiveCustomer, getCustomerProfile);
router.put("/profile", verifyToken, requireActiveCustomer, updateCustomerProfile);

// Wallet
router.get("/transactions", verifyToken, getCustomerTransactions);
router.get("/wallet", verifyToken, requireActiveCustomer, getWalletSummary);
router.post("/wallet/topup", verifyToken, requireActiveCustomer, createWalletTopup);
router.post("/wallet/topup/verify", verifyToken, requireActiveCustomer, verifyWalletTopup);

export default router;
