import express from "express";
import {
    listCoupons,
    createCoupon,
    updateCoupon,
    deleteCoupon,
} from "../controller/couponController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

// Admin management
router.get("/admin/coupons", verifyToken, allowRoles("admin", "parcel_admin"), listCoupons);
router.post("/admin/coupons", verifyToken, allowRoles("admin", "parcel_admin"), createCoupon);
router.put("/admin/coupons/:id", verifyToken, allowRoles("admin", "parcel_admin"), updateCoupon);
router.delete("/admin/coupons/:id", verifyToken, allowRoles("admin", "parcel_admin"), deleteCoupon);

// Customer‑facing (listing only — Porter booking flows validate/apply
// coupons server-side via couponService.computeBookingDiscount, not this route)
router.get("/coupons", listCoupons);

export default router;

