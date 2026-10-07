import Delivery from "../models/delivery.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import { sendSmsIndiaHubOtp } from "../services/smsIndiaHubService.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import { incrementWindowCounter } from "../utils/otpRateLimit.js";
import { uploadImageWithFallback } from "../services/mediaService.js";
import { clearRiderPresence } from "../services/firebaseService.js";
import { syncDeliveryPartnerBusyFlag } from "../services/deliveryBusyService.js";
import { bumpOwnSession } from "../services/sessionService.js";
import { offerOpenParcelsToRider } from "../services/parcelWorkflowService.js";
import { getActiveZoneById, isZoneGatingActive } from "../services/deliveryZoneService.js";

// Same OTP_RATE_LIMIT / OTP_RATE_WINDOW knob the customer OTP flow uses —
// how many OTP sends a single phone number may request per window, so a
// script can't rack up SMS charges hammering /send-login-otp.
const OTP_SEND_LIMIT_PER_WINDOW = () =>
    parseInt(process.env.OTP_RATE_LIMIT || "100", 10);
const OTP_SEND_LIMIT_WINDOW_SECONDS = () =>
    parseInt(process.env.OTP_RATE_WINDOW || "900", 10);
const OTP_MAX_FAILED_ATTEMPTS = () =>
    parseInt(process.env.OTP_MAX_ATTEMPTS || "5", 10);
const OTP_LOCKOUT_MINUTES = () =>
    parseInt(process.env.OTP_LOCKOUT_MINUTES || "15", 10);

const generateToken = (delivery) =>
    jwt.sign(
        { id: delivery._id, role: "delivery", sv: delivery.sessionVersion || 0 },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

const parseBool = (value) =>
    value === true || value === "true" || value === "1";

const otpExpiryMs = () =>
    parseInt(process.env.OTP_EXPIRY_MINUTES || "5", 10) * 60 * 1000;

// uploadImageWithFallback returns a host-relative "/uploads/..." path when
// Cloudinary is unavailable; make it absolute the same way mediaRoutes.js
// does, so a relative URL doesn't get saved to the Delivery document.
const absolutizeUpload = (req, url) =>
    url && url.startsWith("/uploads/") ? `${req.protocol}://${req.get("host")}${url}` : url;

const pickBodyString = (body, keys, fallback = "") => {
    for (const key of keys) {
        const value = body?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return String(value).trim();
        }
    }
    return fallback;
};

const normalizePlateValue = (value) =>
    String(value || "").replace(/\s/g, "").toUpperCase();

const normalizeLicenseValue = (value) =>
    String(value || "").replace(/[\s-]/g, "").toUpperCase();

const resolveAadharNumber = (body, existing = "") => {
    const raw = pickBodyString(
        body,
        ["aadharNumber", "aadhar_number", "aadhaarNumber", "aadhaar_number"],
        existing,
    );
    const digits = String(raw).replace(/\D/g, "").slice(0, 12);
    return digits.length === 12 ? digits : "";
};

const resolvePanNumber = (body, existing = "") => {
    const raw = pickBodyString(
        body,
        ["panNumber", "pan_number"],
        existing,
    );
    const pan = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : "";
};

const getUploadedFiles = (req) => {
    if (Array.isArray(req.files)) return req.files;
    if (req.files && typeof req.files === "object") {
        return Object.values(req.files).flat();
    }
    return [];
};

const mergeSignupData = (delivery, deliveryData) => {
    const alwaysSet = new Set(["otp", "otpExpiry", "documents", "isParcelService"]);
    const identityFields = ["aadharNumber", "panNumber", "vehicleNumber", "drivingLicenseNumber"];

    Object.entries(deliveryData).forEach(([key, value]) => {
        if (alwaysSet.has(key)) {
            delivery[key] = value;
            return;
        }
        if (value === undefined || value === null) return;
        if (typeof value === "string" && value.trim() === "") return;
        delivery[key] = value;
    });

    identityFields.forEach((field) => {
        const value = deliveryData[field];
        if (typeof value === "string" && value.trim()) {
            delivery[field] = value.trim();
        }
    });

    // Keep existing identity values when a re-signup omits them.
    identityFields.forEach((field) => {
        const existing = delivery[field];
        if (
            (!deliveryData[field] || deliveryData[field] === "") &&
            typeof existing === "string" &&
            existing.trim()
        ) {
            delivery[field] = existing.trim();
        }
    });
};

// Porter (parcel delivery) is the only service this app runs — every rider
// is a parcel rider. Kept as a resolver (not a hardcoded literal at the call
// site) so a stray `isParcelService: false` in the request body is still
// rejected explicitly rather than silently ignored.
const resolveServiceFlags = (body) => {
    const hasParcel = typeof body?.isParcelService !== "undefined";
    const isParcelService = hasParcel ? parseBool(body.isParcelService) : true;

    if (!isParcelService) {
        return { error: "Courier delivery service is required." };
    }

    return { isParcelService: true };
};

/**
 * Send the OTP without letting a courier failure undo the work.
 *
 * By the time this runs the account and its OTP are already saved, so an SMS
 * provider that is down, misconfigured, or out of credit does not mean the
 * registration failed — but an uncaught throw here reported it as a 500 and
 * left the applicant believing they had to start over. Worse, retrying then
 * hit "already exists".
 *
 * The provider's own message goes to the logs, where someone can act on it.
 * The applicant gets told their details are safe and to try the resend.
 */
const deliverOtpSms = async (phone, otp) => {
    if (!useRealSMS()) return { sent: true, mocked: true };
    try {
        await sendSmsIndiaHubOtp({ phone, otp });
        return { sent: true, mocked: false };
    } catch (error) {
        console.error("[deliveryAuth] OTP SMS failed:", error?.message);
        return { sent: false, error: error?.message };
    }
};

/* ===============================
   CHECK PHONE – already registered?
================================ */
/**
 * Lets the signup form ask before the applicant fills out all 4 steps,
 * instead of only finding out "already exists" after document uploads.
 * Mirrors the same gate signupDelivery uses (isVerified), so a pending or
 * rejected applicant can still resubmit — only an already-approved partner
 * is turned away here.
 */
export const checkDeliveryPhone = async (req, res) => {
    try {
        const phone = String(req.params.phone || "").trim();

        if (!/^\d{10}$/.test(phone)) {
            return handleResponse(res, 400, "A valid 10-digit phone number is required");
        }

        const delivery = await Delivery.findOne({ phone }).select("isVerified");

        if (delivery && delivery.isVerified) {
            return handleResponse(
                res,
                200,
                "This phone number is already registered. Please login instead.",
                { registered: true },
            );
        }

        return handleResponse(res, 200, "Phone number is available", { registered: false });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   SIGNUP – Send OTP
================================ */
export const signupDelivery = async (req, res) => {
    try {
        const body = req.body || {};
        const name = pickBodyString(body, ["name"]);
        const phone = pickBodyString(body, ["phone"]);
        const vehicleType = pickBodyString(body, ["vehicleType"], "bike");
        const email = pickBodyString(body, ["email"]);
        const address = pickBodyString(body, ["address"]);

        if (!name || !phone) {
            return handleResponse(res, 400, "Name and phone are required");
        }

        const sendAllowed = await incrementWindowCounter(`otp:send:phone:delivery:${phone}`, {
            limit: OTP_SEND_LIMIT_PER_WINDOW(),
            windowSeconds: OTP_SEND_LIMIT_WINDOW_SECONDS(),
        });
        if (!sendAllowed) {
            return handleResponse(res, 429, "Too many OTP requests. Try again later.");
        }

        const serviceFlags = resolveServiceFlags(body);
        if (serviceFlags.error) {
            return handleResponse(res, 400, serviceFlags.error);
        }

        let delivery = await Delivery.findOne({ phone });

        if (delivery && delivery.isVerified) {
            return handleResponse(res, 400, "Delivery partner already exists");
        }

        const accountHolder = pickBodyString(body, ["accountHolder", "account_holder"], delivery?.accountHolder || "");
        const accountNumber = pickBodyString(body, ["accountNumber", "account_number"], delivery?.accountNumber || "");
        const ifsc = pickBodyString(body, ["ifsc"], delivery?.ifsc || "").toUpperCase();
        const bankName = pickBodyString(body, ["bankName", "bank_name"], delivery?.bankName || "");
        const upiId = pickBodyString(body, ["upiId", "upi_id"], delivery?.upiId || "").toLowerCase();
        if (upiId && !UPI_PATTERN.test(upiId)) {
            return handleResponse(res, 400, "Enter a valid UPI ID (e.g. name@bank)");
        }
        const resolvedVehicleNumber = normalizePlateValue(
            pickBodyString(body, ["vehicleNumber", "vehicle_number"], delivery?.vehicleNumber || ""),
        );
        const resolvedDrivingLicenseNumber = normalizeLicenseValue(
            pickBodyString(
                body,
                ["drivingLicenseNumber", "driving_license_number", "dlNumber"],
                delivery?.drivingLicenseNumber || "",
            ),
        );
        const resolvedAadharNumber = resolveAadharNumber(body, delivery?.aadharNumber || "");
        const resolvedPanNumber = resolvePanNumber(body, delivery?.panNumber || "");

        const finalAadhar = resolvedAadharNumber || String(delivery?.aadharNumber || "").replace(/\D/g, "");
        const finalPan = resolvedPanNumber || String(delivery?.panNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

        if (!finalAadhar || finalAadhar.length !== 12 || !finalPan || !/^[A-Z]{5}\d{4}[A-Z]$/.test(finalPan)) {
            return handleResponse(
                res,
                400,
                "Valid 12-digit Aadhar number and PAN are required",
            );
        }

        /**
         * The one zone this rider will work — self-selected here instead of
         * assigned later by an admin. Required once an admin has drawn at
         * least one zone; before that (a fresh install with none configured
         * yet) signup is unaffected, same as every other zone-gated flow.
         */
        const zoneId = pickBodyString(body, ["zoneId", "zone_id"]);
        let resolvedZoneId = null;
        if (zoneId) {
            const zone = await getActiveZoneById(zoneId);
            if (!zone) {
                return handleResponse(
                    res,
                    400,
                    "The selected zone is no longer available. Please pick another.",
                );
            }
            resolvedZoneId = zone._id;
        } else if (await isZoneGatingActive()) {
            return handleResponse(res, 400, "Please select the zone you will deliver in");
        }

        let otp = generateOTP();

        let aadharUrl = delivery?.documents?.aadhar || "";
        let aadharFrontUrl = delivery?.documents?.aadharFront || "";
        let aadharBackUrl = delivery?.documents?.aadharBack || "";
        let panUrl = delivery?.documents?.pan || "";
        let dlUrl = delivery?.documents?.drivingLicense || "";
        let profileImageUrl = delivery?.profileImage || "";

        /**
         * Image hosting is a third party and it can be down, out of quota, or
         * suspended. When it is, the failure used to arrive as a 500 carrying
         * the provider's own words — an applicant would reach the end of a
         * multi-step form and be told "cloud_name is disabled", which means
         * nothing to them and suggests they did something wrong.
         *
         * The provider's message is logged for whoever can act on it; the
         * applicant gets a sentence about the service, and a 503 so the app
         * can tell "try again shortly" apart from "your details are wrong".
         */
        /**
         * Uploads fall back to inline storage when the image host is
         * unavailable, so a suspended bucket somewhere else cannot stop
         * someone registering. The only failure left is an image too large to
         * inline, which the applicant can act on.
         */
        try {
            for (const file of getUploadedFiles(req)) {
                const opts = { mimeType: file.mimetype };
                if (file.fieldname === "profileImage") {
                    profileImageUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/profiles", opts));
                } else if (file.fieldname === "aadhar") {
                    aadharUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/documents", opts));
                } else if (file.fieldname === "aadharFront") {
                    aadharFrontUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/documents", opts));
                } else if (file.fieldname === "aadharBack") {
                    aadharBackUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/documents", opts));
                } else if (file.fieldname === "pan") {
                    panUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/documents", opts));
                } else if (file.fieldname === "dl") {
                    dlUrl = absolutizeUpload(req, await uploadImageWithFallback(file.buffer, "delivery/documents", opts));
                }
            }
        } catch (uploadError) {
            console.error("[deliverySignup] document upload failed:", uploadError?.message);
            return handleResponse(
                res,
                uploadError?.statusCode || 503,
                uploadError?.statusCode === 413
                    ? uploadError.message
                    : "We couldn't save your photos. Please try again in a few minutes.",
                { code: uploadError?.code || "UPLOAD_UNAVAILABLE" },
            );
        }

        const normalizedAadhar = pickBodyString(body, ["aadharUrl"]);
        const normalizedAadharFront = pickBodyString(body, ["aadharFrontUrl"]);
        const normalizedAadharBack = pickBodyString(body, ["aadharBackUrl"]);
        const normalizedPan = pickBodyString(body, ["panUrl"]);
        const normalizedDl = pickBodyString(body, ["drivingLicenseUrl", "dlUrl"]);
        const normalizedProfileImage = pickBodyString(body, ["profileImageUrl", "profileImage"]);

        if (/^https?:\/\//i.test(normalizedAadhar)) aadharUrl = normalizedAadhar;
        if (/^https?:\/\//i.test(normalizedAadharFront)) aadharFrontUrl = normalizedAadharFront;
        if (/^https?:\/\//i.test(normalizedAadharBack)) aadharBackUrl = normalizedAadharBack;
        if (/^https?:\/\//i.test(normalizedPan)) panUrl = normalizedPan;
        if (/^https?:\/\//i.test(normalizedDl)) dlUrl = normalizedDl;
        if (/^https?:\/\//i.test(normalizedProfileImage)) profileImageUrl = normalizedProfileImage;

        // A rejected applicant resubmitting is a reapply: the admin queue shows
        // it as such, and the rejection stays on record.
        const wasRejected = delivery?.applicationStatus === "rejected";
        const deliveryData = {
            name,
            phone,
            vehicleType,
            email,
            address,
            vehicleNumber: resolvedVehicleNumber,
            drivingLicenseNumber: resolvedDrivingLicenseNumber,
            accountHolder,
            accountNumber,
            ifsc,
            bankName,
            upiId,
            profileImage: profileImageUrl,
            experience: pickBodyString(body, ["experience"]),
            experienceDetails: pickBodyString(body, ["experienceDetails", "experience_details"]),
            isParcelService: serviceFlags.isParcelService,
            // A resubmission after rejection is a fresh application, not a
            // continuation of the rejected one — send it back to the queue.
            applicationStatus: "pending",
            ...(wasRejected
                ? { reappliedAt: new Date(), reapplyCount: (delivery?.reapplyCount || 0) + 1 }
                : {}),
            documents: {
                aadhar: aadharUrl,
                aadharFront: aadharFrontUrl,
                aadharBack: aadharBackUrl,
                pan: panUrl,
                drivingLicense: dlUrl,
            },
            otp,
            otpExpiry: Date.now() + otpExpiryMs(),
        };

        if (resolvedAadharNumber) {
            deliveryData.aadharNumber = resolvedAadharNumber;
        } else if (finalAadhar.length === 12) {
            deliveryData.aadharNumber = finalAadhar;
        }
        if (resolvedPanNumber) {
            deliveryData.panNumber = resolvedPanNumber;
        } else if (/^[A-Z]{5}\d{4}[A-Z]$/.test(finalPan)) {
            deliveryData.panNumber = finalPan;
        }
        if (resolvedZoneId) {
            deliveryData.zoneIds = [resolvedZoneId];
        }

        if (!delivery) {
            delivery = await Delivery.create(deliveryData);
        } else {
            mergeSignupData(delivery, deliveryData);
            await delivery.save();
        }

        const delivery_sms = await deliverOtpSms(phone, otp);
        if (!delivery_sms.sent) {
            return handleResponse(
                res,
                502,
                "We couldn't send your code just now. Your details are saved — tap resend in a moment.",
                { code: "OTP_SMS_FAILED", canResend: true },
            );
        }

        return handleResponse(res, 200, "OTP sent successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   LOGIN – Send OTP
================================ */
export const loginDelivery = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return handleResponse(res, 400, "Phone number is required");
        }

        const sendAllowed = await incrementWindowCounter(`otp:send:phone:delivery:${phone}`, {
            limit: OTP_SEND_LIMIT_PER_WINDOW(),
            windowSeconds: OTP_SEND_LIMIT_WINDOW_SECONDS(),
        });
        if (!sendAllowed) {
            return handleResponse(res, 429, "Too many OTP requests. Try again later.");
        }

        const delivery = await Delivery.findOne({ phone });

        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        // A rejected rider may log in to read the reason and reapply; everyone
        // else still waiting on the queue is kept out until approved.
        if (!delivery.isVerified && delivery.applicationStatus !== "rejected") {
            return handleResponse(res, 403, "Your application is pending admin approval.");
        }

        if (delivery.isActive === false) {
            return handleResponse(
                res,
                403,
                "Your account has been deactivated by admin. Please contact support for help.",
                { code: "ACCOUNT_DEACTIVATED" },
            );
        }

        let otp = generateOTP();

        delivery.otp = otp;
        delivery.otpExpiry = Date.now() + otpExpiryMs();
        delivery.otpFailedAttempts = 0;
        delivery.otpLockedUntil = undefined;
        await delivery.save();

        const delivery_sms = await deliverOtpSms(phone, otp);
        if (!delivery_sms.sent) {
            return handleResponse(
                res,
                502,
                "We couldn't send your code just now. Your details are saved — tap resend in a moment.",
                { code: "OTP_SMS_FAILED", canResend: true },
            );
        }

        return handleResponse(res, 200, "OTP sent successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   VERIFY OTP
================================ */
export const verifyDeliveryOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return handleResponse(res, 400, "Phone and OTP are required");
        }

        const delivery = await Delivery.findOne({ phone }).select(
            "+otp +otpExpiry +otpFailedAttempts +otpLockedUntil",
        );

        if (!delivery) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        const now = new Date();
        if (delivery.otpLockedUntil && delivery.otpLockedUntil > now) {
            return handleResponse(
                res,
                423,
                "Too many failed attempts. Please try again later.",
            );
        }

        const isValid =
            delivery.otp === String(otp) &&
            delivery.otpExpiry &&
            delivery.otpExpiry > Date.now();

        if (!isValid) {
            delivery.otpFailedAttempts = (delivery.otpFailedAttempts || 0) + 1;
            if (delivery.otpFailedAttempts >= OTP_MAX_FAILED_ATTEMPTS()) {
                delivery.otpLockedUntil = new Date(
                    now.getTime() + OTP_LOCKOUT_MINUTES() * 60 * 1000,
                );
            }
            await delivery.save();
            return handleResponse(
                res,
                delivery.otpLockedUntil ? 423 : 400,
                delivery.otpLockedUntil
                    ? "Too many failed attempts. Please try again later."
                    : "Invalid or expired OTP",
            );
        }

        // Covers the gap between an OTP being sent and admin deactivating the
        // account in between — loginDelivery already blocks the send step,
        // this stops that already-issued code from still completing login.
        if (delivery.isActive === false) {
            return handleResponse(
                res,
                403,
                "Your account has been deactivated by admin. Please contact support for help.",
                { code: "ACCOUNT_DEACTIVATED" },
            );
        }

        // Only set isOnline to true if the rider is verified
        if (delivery.isVerified) {
            delivery.isOnline = true;
        } else {
            delivery.isOnline = false;
        }
        delivery.otp = undefined;
        delivery.otpExpiry = undefined;
        delivery.otpFailedAttempts = 0;
        delivery.otpLockedUntil = undefined;
        delivery.lastLogin = new Date();

        await delivery.save();

        // Single active session for THIS account only — never touches a
        // customer account that happens to share the same phone number.
        delivery.sessionVersion = await bumpOwnSession(Delivery, delivery._id);
        const token = generateToken(delivery);

        return handleResponse(res, 200, "Login successful", {
            token,
            delivery,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   GET PROFILE
================================ */
export const getDeliveryProfile = async (req, res) => {
    try {
        const delivery = await Delivery.findById(req.user.id).populate(
            "zoneIds",
            "name city color",
        );
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }
        const busy = await syncDeliveryPartnerBusyFlag(req.user.id);
        delivery.isBusy = busy;
        return handleResponse(res, 200, "Profile fetched successfully", delivery);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE PROFILE
================================ */
const PROFILE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const updateDeliveryProfile = async (req, res) => {
    try {
        const {
            name,
            email,
            address,
            vehicleType,
            vehicleNumber,
            drivingLicenseNumber,
            currentArea,
            isOnline,
            experience,
            experienceDetails,
            isParcelService,
            zoneId,
        } = req.body;

        const delivery = await Delivery.findById(req.user.id);
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        if (name) delivery.name = name;

        if (typeof email !== 'undefined') {
            const trimmedEmail = String(email).trim();
            if (trimmedEmail && !PROFILE_EMAIL_REGEX.test(trimmedEmail)) {
                return handleResponse(res, 400, "Please enter a valid email address");
            }
            delivery.email = trimmedEmail;
        }

        if (typeof address !== 'undefined') delivery.address = String(address).trim();

        if (vehicleType) delivery.vehicleType = vehicleType;
        if (vehicleNumber) delivery.vehicleNumber = vehicleNumber;
        if (drivingLicenseNumber) delivery.drivingLicenseNumber = drivingLicenseNumber;
        if (currentArea) delivery.currentArea = currentArea;
        if (typeof experience !== 'undefined') delivery.experience = experience;
        if (typeof experienceDetails !== 'undefined') delivery.experienceDetails = experienceDetails;

        // Capture going-offline transition before the save so we know whether
        // to drop the rider's realtime presence nodes after the write.
        const wasOnline = delivery.isOnline === true;
        const willGoOffline =
            typeof isOnline !== 'undefined' && isOnline === false && wasOnline;
        if (typeof isOnline !== 'undefined') {
            if (parseBool(isOnline) && !delivery.isVerified) {
                return handleResponse(
                    res,
                    403,
                    "Your account is pending admin approval. You cannot go online yet.",
                );
            }
            delivery.isOnline = parseBool(isOnline);
        }
        if (!delivery.isVerified) {
            delivery.isOnline = false;
        }
        if (typeof isParcelService !== 'undefined') {
            delivery.isParcelService = parseBool(isParcelService);
        }
        if (delivery.isParcelService === false) {
            return handleResponse(
                res,
                400,
                "Courier service must remain enabled.",
            );
        }

        /**
         * The rider's one work zone. Self-service replacement for the old
         * admin "assign a rider to zones" screen — only one zone at a time,
         * so switching areas is a deliberate swap, not an accumulating list.
         * Sending an empty string clears it, reverting to the legacy
         * "wherever the rider's live GPS puts them" behaviour.
         */
        if (typeof zoneId !== "undefined") {
            const trimmedZoneId = String(zoneId || "").trim();
            if (!trimmedZoneId) {
                delivery.zoneIds = [];
            } else {
                const zone = await getActiveZoneById(trimmedZoneId);
                if (!zone) {
                    return handleResponse(
                        res,
                        400,
                        "The selected zone is no longer available. Please pick another.",
                    );
                }
                delivery.zoneIds = [zone._id];
            }
        }

        await delivery.save();
        await delivery.populate("zoneIds", "name city color");

        // A rider who just came online gets any booking that was left without
        // a rider while nobody was available (see offerOpenParcelsToRider).
        if (!wasOnline && delivery.isOnline === true) {
            offerOpenParcelsToRider(delivery._id).catch((err) =>
                console.warn("[delivery] reopen parcels failed", err.message),
            );
        }

        // Fire-and-forget — never blocks the HTTP response. A failed cleanup
        // is also safe: the scheduled sweep job will pick it up on TTL.
        if (willGoOffline) {
            clearRiderPresence(String(delivery._id)).catch(() => {});
        }

        return handleResponse(res, 200, "Profile updated successfully", delivery);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE PAYOUT DETAILS

   Where the rider's withdrawals actually get sent. These were previously
   captured once at signup and never editable, while the admin approving a
   withdrawal was shown none of them — so money was approved with no
   destination on screen. The rider owns this data; the admin reads it.
================================ */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_PATTERN = /^[\w.\-]{2,60}@[a-zA-Z]{2,20}$/;

export const updateDeliveryPayoutDetails = async (req, res) => {
    try {
        const { accountHolder, accountNumber, ifsc, bankName, upiId, qrImageUrl } =
            req.body || {};

        const delivery = await Delivery.findById(req.user.id);
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        if (accountHolder !== undefined) {
            delivery.accountHolder = String(accountHolder).trim();
        }
        if (bankName !== undefined) {
            delivery.bankName = String(bankName).trim();
        }

        if (accountNumber !== undefined) {
            const digits = String(accountNumber).replace(/\s/g, "");
            if (digits && !/^\d{9,18}$/.test(digits)) {
                return handleResponse(res, 400, "Account number must be 9 to 18 digits");
            }
            delivery.accountNumber = digits;
        }

        if (ifsc !== undefined) {
            const code = String(ifsc).trim().toUpperCase();
            if (code && !IFSC_PATTERN.test(code)) {
                return handleResponse(res, 400, "Enter a valid IFSC code (e.g. HDFC0001234)");
            }
            delivery.ifsc = code;
        }

        if (upiId !== undefined) {
            const upi = String(upiId).trim();
            if (upi && !UPI_PATTERN.test(upi)) {
                return handleResponse(res, 400, "Enter a valid UPI ID (e.g. name@bank)");
            }
            delivery.upiId = upi;
        }

        if (qrImageUrl !== undefined) {
            delivery.qrImageUrl = String(qrImageUrl).trim();
        }

        // A payout destination that is half-filled is worse than none — the
        // admin would try to pay into it and fail.
        const hasBank = Boolean(
            delivery.accountHolder && delivery.accountNumber && delivery.ifsc,
        );
        const hasUpi = Boolean(delivery.upiId);
        const hasQr = Boolean(delivery.qrImageUrl);

        if (!hasBank && !hasUpi && !hasQr) {
            return handleResponse(
                res,
                400,
                "Add at least one payout method: full bank details, a UPI ID, or a QR image",
            );
        }

        await delivery.save();

        return handleResponse(res, 200, "Payout details updated", {
            accountHolder: delivery.accountHolder || "",
            accountNumber: delivery.accountNumber || "",
            ifsc: delivery.ifsc || "",
            bankName: delivery.bankName || "",
            upiId: delivery.upiId || "",
            qrImageUrl: delivery.qrImageUrl || "",
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
