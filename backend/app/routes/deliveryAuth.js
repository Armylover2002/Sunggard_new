import express from "express";
import {
  signupDelivery,
  loginDelivery,
  verifyDeliveryOTP,
  checkDeliveryPhone,
  getDeliveryProfile,
  updateDeliveryProfile,
  updateDeliveryPayoutDetails,
} from "../controller/deliveryAuthController.js";
import {
  riderGetCashSummary,
  riderCreateCashDeposit,
  riderListCashDeposits,
  riderGetCashPayoutDestination,
  riderGetCashStatus,
  riderStartOnlineDeposit,
  riderVerifyOnlineDeposit,
  riderCreateCodQr,
  riderCheckCodQr,
} from "../controller/riderCashController.js";
import {
  getDeliveryStats,
  getDeliveryEarnings,
  getMyDeliveryOrders,
  requestWithdrawal,
  updateDeliveryLocation,
} from "../controller/deliveryController.js";
import { getRiderWalletSummaryController } from "../controller/adminFinanceController.js";

import { verifyToken, allowRoles, requireActiveDelivery } from "../middleware/authMiddleware.js";
import multer from "multer";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/send-signup-otp",
  upload.any(),
  signupDelivery,
);
router.post("/send-login-otp", loginDelivery);
router.post("/verify-otp", verifyDeliveryOTP);

// Lets the join form warn as soon as the phone is entered, instead of only
// after all 4 signup steps and document uploads are complete.
router.get("/check-phone/:phone", checkDeliveryPhone);

// Profile routes — GET /profile stays reachable without requireActiveDelivery
// so a deactivated rider's app can still load their own profile (and see why
// they're locked out) rather than getting a bare, unexplained 403 on launch.
router.get("/profile", verifyToken, getDeliveryProfile);
router.put("/profile", verifyToken, requireActiveDelivery, updateDeliveryProfile);
router.get("/stats", verifyToken, requireActiveDelivery, getDeliveryStats);
router.get("/earnings", verifyToken, requireActiveDelivery, getDeliveryEarnings);
router.get("/wallet/summary", verifyToken, allowRoles("delivery"), requireActiveDelivery, getRiderWalletSummaryController);
router.get(
  "/order-history",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  getMyDeliveryOrders,
);
router.post("/request-withdrawal", verifyToken, requireActiveDelivery, requestWithdrawal);
router.post("/location", verifyToken, requireActiveDelivery, updateDeliveryLocation);

// Where withdrawals get paid — owned by the rider, read by the admin.
router.put(
  "/payout-details",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  updateDeliveryPayoutDetails,
);

/**
 * Porter COD cash the rider is physically holding, and handing it back.
 * Distinct from /cod/* above, which settles parcel COD cash.
 */
router.get("/cash/summary", verifyToken, allowRoles("delivery"), requireActiveDelivery, riderGetCashSummary);
router.post("/cash/deposit", verifyToken, allowRoles("delivery"), requireActiveDelivery, riderCreateCashDeposit);
router.get("/cash/deposits", verifyToken, allowRoles("delivery"), requireActiveDelivery, riderListCashDeposits);
/**
 * The cash limit meter: what the rider holds, what they may hold, what is
 * left, and whether jobs have stopped.
 *
 * Polled alongside the job feed so the number is always live. A rider whose
 * jobs simply stopped appearing, with no explanation, has been failed by the
 * product — this is what prevents that.
 */
router.get(
  "/cash/status",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  riderGetCashStatus,
);

/**
 * Depositing online.
 *
 * POST opens a gateway order for the rider's FULL held balance — the amount
 * is summed server-side from the bookings they actually hold, never taken
 * from the request. POST /verify confirms the receipt, reads the real status
 * back from the gateway, and raises the deposit for admin approval.
 *
 * This replaces the transfer-to-a-published-UPI-and-upload-a-screenshot flow.
 * A screenshot proved nothing; a captured gateway payment does.
 */
router.post(
  "/cash/deposit/online",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  riderStartOnlineDeposit,
);
router.post(
  "/cash/deposit/online/verify",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  riderVerifyOnlineDeposit,
);

/**
 * @deprecated Superseded by /cash/deposit/online above.
 *
 * Read-only view of the admin-configured UPI / QR / bank destination. Kept so
 * an operation whose gateway is unavailable can still fall back to an
 * out-of-band transfer, and so historical deposits still render.
 */
router.get(
  "/cash/payout-destination",
  verifyToken,
  allowRoles("delivery"),
  requireActiveDelivery,
  riderGetCashPayoutDestination,
);

/**
 * Doorstep switch from cash to online. `kind` is parcel.
 * POST mints (or returns) the QR; GET asks Razorpay whether it was paid and,
 * the first time it has been, converts the booking to an online payment.
 */
router.post("/cod-qr/:kind/:id", verifyToken, allowRoles("delivery"), requireActiveDelivery, riderCreateCodQr);
router.get("/cod-qr/:kind/:id", verifyToken, allowRoles("delivery"), requireActiveDelivery, riderCheckCodQr);

// NOTE: Delivery-completion OTP generation/validation lives on the
// canonical workflow routes:
//   POST /orders/workflow/:orderId/otp/request
//   POST /orders/workflow/:orderId/otp/verify
// The previous /delivery/orders/:orderId/(generate|validate)-otp
// endpoints were removed once the workflow state machine became the
// single source of truth (see backend/app/services/orderWorkflowService.js
// requestHandoffOtpAtomic / verifyHandoffOtpAndDeliver).

export default router;
