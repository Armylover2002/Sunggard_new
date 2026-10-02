import express from "express";
import {
    bootstrapAdmin,
    loginAdmin,
    forgotPasswordSendOtp,
    forgotPasswordVerifyOtp,
    resetAdminPasswordController,
} from "../controller/adminAuthController.js";
import {
    getAdminProfile,
    updateAdminProfile,
    updateAdminPassword,
    getDeliveryPartners,
    getDeliveryPartnerById,
    updateDeliveryPartnerIdentity,
    approveDeliveryPartner,
    rejectDeliveryPartner,
    setDeliveryPartnerActive,
    getAdminWalletData,
    getDeliveryTransactions,
    settleTransaction,
    bulkSettleDelivery,
    getActiveSellers,
    getPendingSellers,
    approveSellerApplication,
    rejectSellerApplication,
    getSellerWithdrawals,
    getDeliveryWithdrawals,
    updateWithdrawalStatus,
    getSellerTransactions,
    getDeliveryCashBalances,
    getRiderCashDetails,
    settleRiderCash,
    getCashSettlementHistory,
    getUsers,
    getUserById,
    getLiveFleetLocations,
    getSellers,
    getSellerLocations,
    getPlatformSettings,
    updatePlatformSettings
} from "../controller/adminController.js";
import {
    exportAdminFinanceStatementController,
    getAdminFinanceLedgerController,
} from "../controller/adminFinanceController.js";

import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";
import { validate } from "../middleware/validate.js";
import { adminSettleCashSchema } from "../validation/porterAdminValidation.js";
import {
    adminBootstrapRateLimiter,
    authRouteRateLimiter,
    createContentLengthGuard,
} from "../middleware/securityMiddlewares.js";

const router = express.Router();

const smallAdminPayload = createContentLengthGuard(
    parseInt(process.env.ADMIN_AUTH_MAX_PAYLOAD_BYTES || "20480", 10),
    "Admin auth payload too large",
);
router.post("/bootstrap", adminBootstrapRateLimiter, smallAdminPayload, bootstrapAdmin);
router.post("/login", authRouteRateLimiter, smallAdminPayload, loginAdmin);

// Forgot password — no auth required by definition. Rate-limited the same
// as bootstrap since both are unauthenticated, account-sensitive endpoints.
router.post(
    "/forgot-password/send-otp",
    adminBootstrapRateLimiter,
    smallAdminPayload,
    forgotPasswordSendOtp,
);
router.post(
    "/forgot-password/verify-otp",
    adminBootstrapRateLimiter,
    smallAdminPayload,
    forgotPasswordVerifyOtp,
);
router.post(
    "/forgot-password/reset",
    adminBootstrapRateLimiter,
    smallAdminPayload,
    resetAdminPasswordController,
);

// Profile routes
router.get(
    "/profile",
    verifyToken,
    allowRoles("admin"),
    getAdminProfile
);

router.put(
    "/profile",
    verifyToken,
    allowRoles("admin"),
    updateAdminProfile
);

router.put(
    "/profile/password",
    verifyToken,
    allowRoles("admin"),
    updateAdminPassword
);

router.get(
    "/finance/ledger",
    verifyToken,
    allowRoles("admin"),
    getAdminFinanceLedgerController,
);
router.get(
    "/finance/export-statement",
    verifyToken,
    allowRoles("admin"),
    exportAdminFinanceStatementController,
);
router.get(
    "/settings/platform",
    verifyToken,
    allowRoles("admin"),
    getPlatformSettings
);
router.put(
    "/settings/platform",
    verifyToken,
    allowRoles("admin"),
    updatePlatformSettings
);
router.get("/users", verifyToken, allowRoles("admin"), getUsers);
router.get("/users/:id", verifyToken, allowRoles("admin"), getUserById);
router.get("/sellers", verifyToken, allowRoles("admin"), getSellers);
router.get("/sellers/locations", verifyToken, allowRoles("admin"), getSellerLocations);
router.get("/sellers/active", verifyToken, allowRoles("admin"), getActiveSellers);
router.get("/sellers/pending", verifyToken, allowRoles("admin"), getPendingSellers);
router.patch("/sellers/approve/:id", verifyToken, allowRoles("admin"), approveSellerApplication);
router.delete("/sellers/reject/:id", verifyToken, allowRoles("admin"), rejectSellerApplication);

router.get(
    "/delivery-partners",
    verifyToken,
    allowRoles("admin"),
    getDeliveryPartners
);

// Must stay above "/delivery-partners/:id" — otherwise Express matches the
// :id param route first and tries to cast "live-locations" as an ObjectId.
router.get(
    "/delivery-partners/live-locations",
    verifyToken,
    allowRoles("admin"),
    getLiveFleetLocations,
);

router.get(
    "/delivery-partners/:id",
    verifyToken,
    allowRoles("admin"),
    getDeliveryPartnerById
);

router.patch(
    "/delivery-partners/:id/identity",
    verifyToken,
    allowRoles("admin"),
    updateDeliveryPartnerIdentity
);

router.patch(
    "/delivery-partners/approve/:id",
    verifyToken,
    allowRoles("admin"),
    approveDeliveryPartner
);

router.delete(
    "/delivery-partners/reject/:id",
    verifyToken,
    allowRoles("admin"),
    rejectDeliveryPartner
);

router.patch(
    "/delivery-partners/:id/active",
    verifyToken,
    allowRoles("admin"),
    setDeliveryPartnerActive
);

router.get("/wallet-data", verifyToken, allowRoles("admin"), getAdminWalletData);

// Delivery Payouts / Funds
router.get("/delivery-transactions", verifyToken, allowRoles('admin'), getDeliveryTransactions);
router.put("/transactions/:id/settle", verifyToken, allowRoles("admin"), settleTransaction);
router.put("/transactions/bulk-settle-delivery", verifyToken, allowRoles("admin"), bulkSettleDelivery);

// Cash Collection Hub
router.get("/delivery-cash", verifyToken, allowRoles("admin"), getDeliveryCashBalances);
router.get("/rider-cash-details/:id", verifyToken, allowRoles("admin"), getRiderCashDetails);
router.post("/settle-cash", verifyToken, allowRoles("admin"), validate(adminSettleCashSchema), settleRiderCash);
router.get("/cash-history", verifyToken, allowRoles("admin"), getCashSettlementHistory);

// Seller Withdrawal Management
router.get("/seller-withdrawals", verifyToken, allowRoles("admin"), getSellerWithdrawals);
router.get("/delivery-withdrawals", verifyToken, allowRoles("admin"), getDeliveryWithdrawals);
router.get("/seller-transactions", verifyToken, allowRoles("admin"), getSellerTransactions);
router.put("/withdrawals/:id", verifyToken, allowRoles("admin"), updateWithdrawalStatus);

// Protected admin route example
router.get(
    "/dashboard",
    verifyToken,
    allowRoles("admin"),
    (req, res) => {
        res.json({
            success: true,
            message: "Welcome to Admin Dashboard",
        });
    }
);

export default router;
