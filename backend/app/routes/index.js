import customerRoute from "./customerAuth.js";
import deliveryRoute from "./deliveryAuth.js";
import adminRoute from "./adminAuth.js";
import sellerRoute from "./sellerAuth.js";
import paymentRoute from "./paymentRoutes.js";
import notificationRoute from "./notificationRoutes.js";
import pushRoute from "./pushRoutes.js";
import ticketRoute from "./ticketRoutes.js";
import faqRoute from "./faqRoutes.js";
import couponRoute from "./couponRoutes.js";
import settingsRoute from "./settingsRoutes.js";
import mapsRoute from "./mapsRoutes.js";
import mediaRoute from "./mediaRoutes.js";
import healthRoute from "./healthRoutes.js";
import metricsRoute from "./metricsRoutes.js";
import authOtpRoute from "../modules/otp/otp.routes.js";
import parcelRoute from "./parcelRoutes.js";
import porterRoute from "./porterRoutes.js";
// CAR WASH DISABLED — re-enable by uncommenting import + mount below
// import carWashRoute from "./carWashRoutes.js";


import express from "express";

const setupRoutes = (app) => {
    const router = express.Router();

    // Health and metrics endpoints (no /api prefix for standard paths)
    app.use("/health", healthRoute);
    app.use("/metrics", metricsRoute);

    router.use("/customer", customerRoute);
    router.use("/delivery", deliveryRoute);
    router.use("/admin", adminRoute);
    router.use("/seller", sellerRoute);
    router.use("/settings", settingsRoute);
    router.use("/payments", paymentRoute);
    router.use("/maps", mapsRoute);
    router.use("/media", mediaRoute);
    // couponRoute is mounted at "/" intentionally: it declares ABSOLUTE
    // paths internally (e.g. router.get("/admin/coupons", ...)). Mounting
    // it under an explicit prefix would double the path and break every
    // existing frontend caller.
    router.use("/", couponRoute);
    router.use("/notifications", notificationRoute);
    router.use("/auth/otp", authOtpRoute);
    router.use("/push", pushRoute);
    router.use("/tickets", ticketRoute);
    router.use("/admin/faqs", faqRoute);
    router.use("/public/faqs", faqRoute); // For public access without admin prefix
    router.use("/parcel", parcelRoute);
    // Porter desk: parcel-side dashboard and delivery zones. Reads from both
    // parcel modules above; owns nothing they depend on.
    router.use("/porter", porterRoute);
    // CAR WASH DISABLED
    // router.use("/car-wash", carWashRoute);


    app.use("/api", router);
}
export default setupRoutes;
