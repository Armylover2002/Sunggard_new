import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import { verifyToken, allowRoles, requireActiveCustomer } from "../middleware/authMiddleware.js";
import { validate } from "../middleware/validate.js";
import {
  adminCreateCourierSchema,
  adminUpdateCourierSchema,
  adminUpdateParcelPricingSchema,
} from "../validation/porterAdminValidation.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
import {
  calculateFare,
  getAvailableCoupons,
  validateBookingCoupon,
  createParcel,
  verifyParcelPayment,
  getBookingConfig,
  getParcelHistory,
  trackParcel,
  cancelParcelByCustomer,
  requestParcelLateRefund,
  adminApproveParcelLateRefund,
  adminRejectParcelLateRefund,
  adminGetParcels,
  adminGetParcelById,
  adminAssignRider,
  adminGetPricingConfig,
  adminUpdatePricingConfig,
  adminGetReports,
  adminGetActiveDeliveries,
  adminResetAllParcelData,
  adminGetRiders,
  riderGetAssignedParcels,
  riderGetAvailableParcels,
  getParcelRoute,
  riderAcceptParcel,
  riderRejectParcel,
  riderUpdateStatus,
  riderGetEarnings,
  sellerGetParcels,
  sellerConfirmCodReceived,
  sellerCreateCodRemitPayment,
  sellerVerifyCodRemitPayment,
} from "../controller/parcelController.js";
import { requireApprovedSeller } from "../middleware/authMiddleware.js";
import {
  adminListCourierCompanies,
  adminCreateCourierCompany,
  adminUpdateCourierCompany,
  adminDeleteCourierCompany,
  listCouriersForLocation,
} from "../controller/courierCompanyController.js";
import {
  adminUploadCityRates,
  adminListCityRates,
  adminUpsertCityRate,
  adminDeleteCityRate,
  adminDownloadCityRateTemplate,
  listCityRateDestinations,
} from "../controller/parcelCityRateController.js";
import {
  submitParcelReview,
  getMyParcelReview,
  listPublicParcelReviews,
  adminListParcelReviews,
  adminUpdateParcelReviewStatus,
} from "../controller/parcelReviewController.js";

const router = express.Router();

/**
 * Reject a malformed parcel id before Mongoose sees it.
 *
 * Without this, an id like "not-an-id" throws a CastError that surfaces as a
 * 500 carrying the internal model name and field path — an error the caller
 * cannot act on and should not be shown. A bad id in the URL is the caller's
 * mistake and belongs in the 400 range.
 *
 * Registered as a param handler so every route taking :parcelId is covered,
 * including any added later.
 */
router.param("parcelId", (req, res, next, value) => {
  if (!mongoose.Types.ObjectId.isValid(String(value))) {
    return res.status(400).json({
      success: false,
      error: true,
      message: "That parcel reference is not valid",
    });
  }
  return next();
});

/* ==========================================================================
   CUSTOMER API ROUTES
   ========================================================================== */
router.post("/calculate-fare", verifyToken, calculateFare);
router.get("/coupons/available", verifyToken, requireActiveCustomer, getAvailableCoupons);
router.post("/coupon/validate", verifyToken, requireActiveCustomer, validateBookingCoupon);
router.post("/create", verifyToken, requireActiveCustomer, createParcel);
router.post("/verify-payment", verifyToken, verifyParcelPayment);
router.get("/booking-config", verifyToken, getBookingConfig);
router.get("/history", verifyToken, getParcelHistory);
router.get("/track/:id", verifyToken, trackParcel);
router.post("/cancel/:parcelId", verifyToken, cancelParcelByCustomer);
router.post("/:parcelId/late-refund-request", verifyToken, requestParcelLateRefund);
router.get("/reviews", verifyToken, listPublicParcelReviews);
router.get("/review/:parcelId", verifyToken, getMyParcelReview);
router.post("/review", verifyToken, submitParcelReview);
router.get("/couriers/for-location", verifyToken, listCouriersForLocation);
router.get("/city-rates/destinations", verifyToken, listCityRateDestinations);

/* ==========================================================================
   ADMIN API ROUTES
   ========================================================================== */
router.get("/admin/all", verifyToken, allowRoles("admin", "parcel_admin"), adminGetParcels);
router.post("/admin/assign-rider", verifyToken, allowRoles("admin", "parcel_admin"), adminAssignRider);
router.get("/admin/pricing", verifyToken, allowRoles("admin", "parcel_admin"), adminGetPricingConfig);
router.put("/admin/pricing", verifyToken, allowRoles("admin", "parcel_admin"), validate(adminUpdateParcelPricingSchema), adminUpdatePricingConfig);
router.get("/admin/reports", verifyToken, allowRoles("admin", "parcel_admin"), adminGetReports);
router.get("/admin/active", verifyToken, allowRoles("admin", "parcel_admin"), adminGetActiveDeliveries);
router.post(
  "/admin/reset-data",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminResetAllParcelData,
);
router.get("/admin/riders", verifyToken, allowRoles("admin", "parcel_admin"), adminGetRiders);
router.put(
  "/admin/late-refund/:parcelId/approve",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminApproveParcelLateRefund,
);
router.put(
  "/admin/late-refund/:parcelId/reject",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminRejectParcelLateRefund,
);
router.get(
  "/admin/couriers",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminListCourierCompanies,
);
router.post(
  "/admin/couriers",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  validate(adminCreateCourierSchema),
  adminCreateCourierCompany,
);
router.put(
  "/admin/couriers/:id",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  validate(adminUpdateCourierSchema),
  adminUpdateCourierCompany,
);
router.delete(
  "/admin/couriers/:id",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminDeleteCourierCompany,
);
router.get(
  "/admin/city-rates",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminListCityRates,
);
router.get(
  "/admin/city-rates/template",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminDownloadCityRateTemplate,
);
router.post(
  "/admin/city-rates/upload",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  upload.single("file"),
  adminUploadCityRates,
);
router.post(
  "/admin/city-rates",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminUpsertCityRate,
);
router.delete(
  "/admin/city-rates/:id",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminDeleteCityRate,
);
router.get(
  "/admin/reviews",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminListParcelReviews,
);
router.put(
  "/admin/reviews/:id",
  verifyToken,
  allowRoles("admin", "parcel_admin"),
  adminUpdateParcelReviewStatus,
);
// Keep parameterized route AFTER static /admin/* paths.
router.get("/admin/:parcelId", verifyToken, allowRoles("admin", "parcel_admin"), adminGetParcelById);

/* ==========================================================================
   DELIVERY PARTNER API ROUTES
   ========================================================================== */
router.get("/rider/assigned", verifyToken, allowRoles("delivery"), riderGetAssignedParcels);
router.get("/rider/route/:parcelId", verifyToken, allowRoles("delivery"), getParcelRoute);
router.get("/rider/available", verifyToken, allowRoles("delivery"), riderGetAvailableParcels);
router.post("/rider/accept/:parcelId", verifyToken, allowRoles("delivery"), riderAcceptParcel);
router.post("/rider/reject/:parcelId", verifyToken, allowRoles("delivery"), riderRejectParcel);
router.put("/rider/status", verifyToken, allowRoles("delivery"), riderUpdateStatus);
router.get("/rider/earnings", verifyToken, allowRoles("delivery"), riderGetEarnings);

/* ==========================================================================
   PARCEL HUB SELLER API ROUTES
   ========================================================================== */
router.get(
  "/seller/parcels",
  verifyToken,
  allowRoles("seller"),
  requireApprovedSeller,
  sellerGetParcels,
);
router.post(
  "/seller/cod/confirm",
  verifyToken,
  allowRoles("seller"),
  requireApprovedSeller,
  sellerConfirmCodReceived,
);
router.post(
  "/seller/cod/remit/create",
  verifyToken,
  allowRoles("seller"),
  requireApprovedSeller,
  sellerCreateCodRemitPayment,
);
router.post(
  "/seller/cod/remit/verify",
  verifyToken,
  allowRoles("seller"),
  requireApprovedSeller,
  sellerVerifyCodRemitPayment,
);

export default router;
