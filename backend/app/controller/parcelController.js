import Parcel from "../models/parcel.js";
import ParcelConfig from "../models/parcelConfig.js";
import CourierCompany from "../models/courierCompany.js";
import ParcelCityRate from "../models/parcelCityRate.js";
import Coupon from "../models/coupon.js";
import { computeBookingDiscount, incrementCouponUsage } from "../services/finance/couponService.js";
import Delivery from "../models/delivery.js";
import User from "../models/customer.js";
import Admin from "../models/admin.js";
import { distanceMeters } from "../utils/geoUtils.js";
import handleResponse from "../utils/helper.js";
import Notification from "../models/notification.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { emitToAdmins, emitToDelivery, emitToCustomer, retractParcelBroadcast, emitParcelNewToNearbySellers, emitToSeller } from "../services/orderSocketEmitter.js";
import {
  startParcelBroadcast,
  parcelAcceptAtomic,
  parcelRejectAtomic,
  fetchAvailableParcelsForRider,
  fetchParcelsForSeller,
  cancelParcelSearch,
  computeRiderParcelEarnings,
  computeRiderParcelEarningBreakdown,
} from "../services/parcelWorkflowService.js";
import { resetAllParcelData } from "../services/parcelDataResetService.js";
import { recordCodCollection } from "../services/riderCashService.js";
import { recordPorterCodCollected } from "../services/porter/customerLedgerService.js";
import { generateParcelOtp } from "../utils/otp.js";
import { getCachedRoute } from "../services/mapsRouteService.js";
import {
  resolveParcelBillableDays,
  applyBillableDaysToFare,
  computeParcelDailyFare,
} from "../utils/parcelFare.js";
import { createParcelCodRemitRazorpayOrder } from "../services/parcelRazorpayService.js";
import { isZoneGatingActive, resolveZoneForPoint } from "../services/deliveryZoneService.js";
import {
  openBookingPayment,
  verifyBookingReceipt,
  refundBookingPayment,
} from "../services/porter/porterPaymentService.js";
import { activatePorterBookingAfterPayment } from "../services/porter/porterDispatchService.js";
import { PORTER_BOOKING_KIND, PORTER_PAYMENT_SOURCE } from "../constants/porterPayment.js";
import logger from "../services/logger.js";
import { findNearestParcelSellerWithDistance } from "../services/sellerNearbyService.js";
import {
  applyParcelDeliveredRiderEarning,
  getSettledParcelEarnings,
} from "../services/parcelRiderSettlementService.js";
import {
  canCustomerRequestLateRefund,
  creditLateRefundToCustomerWallet,
  getParcelLatePickupSummary,
  getParcelPickupDeadline,
  isNormalParcelPickupLate,
  NORMAL_PICKUP_SLA_MINUTES,
} from "../services/parcelLateRefundService.js";
import { rebaseGstAfterDiscount } from "../utils/gst.js";
import { resolvePickupSchedule } from "../utils/parcelSchedule.js";
import { roundCurrency } from "../utils/money.js";
import { recordParcelEvent, PARCEL_EVENT_ACTOR } from "../services/parcelEventService.js";
import ParcelEvent from "../models/parcelEvent.js";
import {
  visibleParcels,
  PARCEL_AWAITING_PAYMENT,
} from "../services/bookingCheckoutService.js";
import {
  canTransition as canParcelTransition,
  transitionRefusal as parcelTransitionRefusal,
} from "../services/parcelStateMachine.js";

function isParcelCod(parcelOrMethod) {
  const method =
    typeof parcelOrMethod === "string"
      ? parcelOrMethod
      : parcelOrMethod?.paymentMethod;
  return String(method || "").toUpperCase() === "COD";
}

function getParcelCollectAmount(parcel) {
  if (!isParcelCod(parcel)) return 0;
  const fromSettlement = Number(parcel?.codSettlement?.collectAmount);
  if (Number.isFinite(fromSettlement) && fromSettlement > 0) return fromSettlement;
  return Math.max(0, Number(parcel?.payableFare) || Number(parcel?.fare) || 0);
}

function buildInitialCodSettlement(paymentMethod, fare) {
  if (!isParcelCod(paymentMethod)) {
    return {
      collectAmount: 0,
      status: "NOT_APPLICABLE",
    };
  }
  return {
    collectAmount: Math.max(0, Number(fare) || 0),
    status: "COLLECT_PENDING",
  };
}

/**
 * Attaches the rider's earning math — distance × rate = amount — onto a
 * plain parcel object, so the rider app can show exactly how a number was
 * reached instead of just the total. Only meaningful once a rider has
 * accepted (riderAcceptLocation set); before that it's zeroed by
 * computeRiderParcelEarningBreakdown itself, same as the existing preview.
 *
 * `settledAmount` (from getSettledParcelEarnings) overrides the live-computed
 * `.earning` for a DELIVERED parcel — the frozen amount actually credited,
 * not a fresh recompute against whatever riderPerKmRate is configured today.
 * Callers listing delivered parcels must pass this; an in-progress parcel has
 * nothing settled yet, so the live preview is correct there.
 */
function withRiderEarningBreakdown(parcelPlainOrDoc, settings, settledAmount = null) {
  const plain = parcelPlainOrDoc?.toObject
    ? parcelPlainOrDoc.toObject()
    : { ...parcelPlainOrDoc };
  plain.riderEarningBreakdown = computeRiderParcelEarningBreakdown(plain, settings);
  if (plain.status === "DELIVERED" && settledAmount != null) {
    plain.riderEarningBreakdown.earning = settledAmount;
  }
  return plain;
}

async function notifyParcelRequested(parcel, userId) {
  try {
    const admins = await Admin.find().select("_id").lean();
    const adminIds = (admins || []).map((a) => a?._id).filter(Boolean);
    emitNotificationEvent(NOTIFICATION_EVENTS.PARCEL_REQUESTED, {
      userId,
      customerId: userId,
      adminIds,
      parcelId: parcel._id,
      fare: parcel.fare,
      // No customerBody: the builder's parcel_request_created_body translation
      // key covers this, so the customer gets it in their chosen language.
      adminBody: `Courier #${String(parcel._id).slice(-6)}${parcel.deliverySpeed === "express" ? " (EXPRESS)" : ""} booked for ₹${parcel.fare}. Open Courier Delivery to view.`,
      data: {
        parcelId: parcel._id,
        fare: parcel.fare,
        deliverySpeed: parcel.deliverySpeed || "normal",
        pickup: parcel.pickupAddress?.fullAddress,
        drop: parcel.dropAddress?.fullAddress,
      },
    });
  } catch (notifyErr) {
    console.error("Failed to notify customer/admins for courier request:", notifyErr);
  }
}

async function activateParcelAfterPayment(parcel) {
  emitToAdmins("parcel:new", parcel);
  await emitParcelNewToNearbySellers(parcel);
  if (parcel?.parcelType === "local") {
    await emitParcelNewToNearbySellers(parcel);
  }
  const searchingParcel = await startParcelBroadcast(parcel);
  return searchingParcel || parcel;
}
import { syncDeliveryPartnerBusyFlag } from "../services/deliveryBusyService.js";

// Utility to send notifications
async function sendParcelNotification(userId, role, title, body, eventType = "alert", parcelId = null, status = null, extra = {}) {
  try {
    if (Object.values(NOTIFICATION_EVENTS).includes(eventType)) {
      emitNotificationEvent(eventType, {
        userId,
        customerId: role === "customer" ? userId : undefined,
        deliveryId: role === "delivery" ? userId : undefined,
        parcelId,
        // Read by dedupeKeyForNotification (payload.parcelId branch) so each
        // lifecycle step of the same parcel gets its own dedupe key instead
        // of only the first status change ever sending.
        status: status || undefined,
        body,
        // Translation key for the body; the notification is written in the recipient's language.
        bodyKey: extra.bodyKey,
        bodyVars: extra.bodyVars,
        data: {
          title,
          parcelId,
          role,
          status: status || undefined,
        }
      });
    } else {
      await Notification.create({
        userId,
        recipient: userId,
        role: role === "customer" ? "customer" : role === "delivery" ? "delivery" : role,
        recipientModel: role === "customer" ? "Customer" : role === "delivery" ? "Delivery" : role === "admin" ? "Admin" : "Seller",
        title,
        body,
        message: body,
        status: "pending",
        type: "alert",
      });
    }
  } catch (err) {
    console.error("Failed to send notification:", err);
  }
}

/* ==========================================================================
   CUSTOMER CONTROLLERS
   ========================================================================== */

/** Distance fallback when a local pickup has no hub nearby. */
const DEFAULT_FIRST_MILE_KM = 5;

/**
 * How far the rider carries the parcel on its first mile.
 *
 * Local parcels are handed to a nearby parcel-hub seller, so that hub has to
 * be in range or the booking is a real refusal. An outstation parcel's price
 * is a flat delivery charge (see utils/parcelFare.js) and its drop point is
 * the customer-selected courier company, not a distance-resolved warehouse —
 * there is nothing to look up, so this just returns a nominal distance.
 *
 * Quoting and booking both call this, so the two never disagree.
 */
async function resolveFirstMile({ lat, lng, isOutstation }) {
  if (!isOutstation) {
    const nearest = await findNearestParcelSellerWithDistance(lat, lng);
    if (!nearest) {
      return {
        error: "No courier hub seller is available near your pickup location",
      };
    }
    return { distanceKm: nearest.distanceKm, nearest };
  }

  return { distanceKm: 0, nearest: null };
}

/**
 * The courier's own charge to ship a parcel from the pickup city to the
 * destination city — looked up from the admin's Excel-uploaded rate card
 * (models/parcelCityRate.js), not computed. There is no fallback price: a
 * route/courier combination the admin hasn't priced is not bookable, so the
 * customer sees "service not available" instead of a made-up number.
 *
 * Shared by calculateFare/validateBookingCoupon/createParcel so a quote and
 * the booking it leads to can never disagree.
 */
async function resolveCourierCityCharge({ originCity, destinationCity, courierCompanyId }) {
  const origin = String(originCity || "").trim();
  const destination = String(destinationCity || "").trim();
  if (!origin) {
    return { error: "Pickup city is required" };
  }
  if (!destination) {
    return { error: "Destination city is required" };
  }
  if (!courierCompanyId) {
    return { error: "Please select a courier company" };
  }
  const rate = await ParcelCityRate.findRate(origin, destination, courierCompanyId);
  if (!rate) {
    return {
      error: `Service not available from ${origin} to ${destination} with the selected courier`,
    };
  }
  return { charge: rate.charge };
}

export const calculateFare = async (req, res) => {
  try {
    const {
      pickupLat,
      pickupLng,
      pickupCity,
      destinationCity,
      weight,
      courierCompany,
      courierCompanyId,
      pickupWindow,
      pickupWindowDays,
      preferredPickupDate,
      deliverySpeed,
    } = req.body;

    if (pickupLat == null || pickupLng == null) {
      return handleResponse(res, 400, "Pickup location is required");
    }

    const pickupLatN = Number(pickupLat);
    const pickupLngN = Number(pickupLng);
    if (!Number.isFinite(pickupLatN) || !Number.isFinite(pickupLngN)) {
      return handleResponse(res, 400, "Invalid pickup location");
    }

    const config = await ParcelConfig.getOrCreate();
    // Cap is admin-set (ParcelConfig.maxWeightKg); the customer form reads the same value.
    const maxWeightKg = config.maxWeightKg;
    const pkgWeight = Number(weight || 0.1);
    if (pkgWeight <= 0 || pkgWeight > maxWeightKg) {
      return handleResponse(
        res,
        400,
        `Weight must be greater than 0 and maximum ${maxWeightKg} KG`,
      );
    }

    const isOutstation =
      String(req.body.parcelType || "outstation").toLowerCase() !== "local";

    // Same first-mile rule the booking itself uses, so a quote can never
    // refuse a pickup that `createParcel` would have accepted.
    const firstMile = await resolveFirstMile({
      lat: pickupLatN,
      lng: pickupLngN,
      isOutstation,
    });
    if (firstMile.error) {
      return handleResponse(res, 400, firstMile.error);
    }
    const { distanceKm, nearest } = firstMile;

    // Outstation only: the courier's own city-to-city charge, looked up from
    // the admin's rate card. No rate for this route+courier = not bookable.
    let courierCityCharge = 0;
    if (isOutstation) {
      const courierKey = courierCompanyId || courierCompany;
      const courierDoc = courierKey ? await CourierCompany.findActiveByNameOrId(courierKey) : null;
      if (!courierDoc) {
        return handleResponse(res, 400, "Please select a valid courier company");
      }
      const cityCharge = await resolveCourierCityCharge({
        originCity: pickupCity,
        destinationCity,
        courierCompanyId: courierDoc._id,
      });
      if (cityCharge.error) {
        return handleResponse(res, 400, cityCharge.error);
      }
      courierCityCharge = cityCharge.charge;
    }

    const daily = computeParcelDailyFare({ config, courierCharge: courierCityCharge, weightKg: pkgWeight, isExpress: String(deliverySpeed || "normal").trim().toLowerCase() === "express" });

    const billableDays = resolveParcelBillableDays({
      pickupWindow,
      pickupWindowDays,
      preferredPickupDate,
    });
    const priced = applyBillableDaysToFare(daily, billableDays, config.gst);

    const sellerName =
      nearest?.seller?.shopName || nearest?.seller?.name || "Courier hub";

    return handleResponse(res, 200, "Fare calculated successfully", {
      distance: distanceKm,
      sellerName,
      fixedDeliveryCharge: config.fixedDeliveryCharge,
      baseFare: priced.baseFare,
      distanceFare: priced.distanceFare,
      weightFare: priced.weightFare,
      platformCharge: priced.platformCharge,
      companyCharge: priced.companyCharge,
      courierCharge: priced.courierCharge,
      expressCharge: priced.expressCharge,
      dailyFare: priced.dailyFare,
      billableDays: priced.billableDays,
      // Tax, itemised. The booking screen shows these as their own lines, so
      // a customer can see what they are paying tax on before they commit
      // rather than discovering it on the invoice.
      taxableAmount: priced.taxableAmount,
      gstPercent: priced.gstPercent,
      gstAmount: priced.gstAmount,
      cgst: priced.cgst,
      sgst: priced.sgst,
      gstInclusive: priced.gstInclusive,
      roundOff: priced.roundOff,
      fare: priced.fare,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Active coupons the customer can pick from before entering a code by hand. */
export const getAvailableCoupons = async (req, res) => {
  try {
    const now = new Date();
    const { fare, parcelType } = req.query;
    const bookingKind = String(parcelType || "outstation").toLowerCase() === "local"
      ? "porter_local"
      : "porter_outstation";
    const query = {
      isActive: true,
      validFrom: { $lte: now },
      validTill: { $gte: now },
      appliesTo: bookingKind,
    };
    if (fare !== undefined && Number.isFinite(Number(fare))) {
      query.minOrderValue = { $lte: Number(fare) };
    }
    const coupons = await Coupon.find(query).sort({ discountValue: -1 }).lean();
    return handleResponse(res, 200, "Available coupons", coupons);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Pre-payment coupon check. Re-quotes the fare server-side with the exact
 * same pricing path `calculateFare` uses, so the fare a coupon discounts is
 * never a number the client sent.
 */
export const validateBookingCoupon = async (req, res) => {
  try {
    const {
      pickupLat,
      pickupLng,
      pickupCity,
      destinationCity,
      weight,
      courierCompany,
      courierCompanyId,
      pickupWindow,
      pickupWindowDays,
      preferredPickupDate,
      deliverySpeed,
      parcelType,
      couponCode,
    } = req.body;

    if (!couponCode) {
      return handleResponse(res, 400, "Coupon code is required");
    }
    if (pickupLat == null || pickupLng == null) {
      return handleResponse(res, 400, "Pickup location is required");
    }

    const pickupLatN = Number(pickupLat);
    const pickupLngN = Number(pickupLng);
    if (!Number.isFinite(pickupLatN) || !Number.isFinite(pickupLngN)) {
      return handleResponse(res, 400, "Invalid pickup location");
    }

    const config = await ParcelConfig.getOrCreate();
    const maxWeightKg = config.maxWeightKg;
    const pkgWeight = Number(weight || 0.1);
    if (pkgWeight <= 0 || pkgWeight > maxWeightKg) {
      return handleResponse(
        res,
        400,
        `Weight must be greater than 0 and maximum ${maxWeightKg} KG`,
      );
    }

    const isLocal = String(parcelType || "outstation").toLowerCase() === "local";
    const firstMile = await resolveFirstMile({
      lat: pickupLatN,
      lng: pickupLngN,
      isOutstation: !isLocal,
    });
    if (firstMile.error) {
      return handleResponse(res, 400, firstMile.error);
    }

    let courierCityCharge = 0;
    if (!isLocal) {
      const courierKey = courierCompanyId || courierCompany;
      const courierDoc = courierKey ? await CourierCompany.findActiveByNameOrId(courierKey) : null;
      if (!courierDoc) {
        return handleResponse(res, 400, "Please select a valid courier company");
      }
      const cityCharge = await resolveCourierCityCharge({
        originCity: pickupCity,
        destinationCity,
        courierCompanyId: courierDoc._id,
      });
      if (cityCharge.error) {
        return handleResponse(res, 400, cityCharge.error);
      }
      courierCityCharge = cityCharge.charge;
    }

    const daily = computeParcelDailyFare({ config, courierCharge: courierCityCharge, weightKg: pkgWeight, isExpress: String(deliverySpeed || "normal").trim().toLowerCase() === "express" });
    const billableDays = resolveParcelBillableDays({
      pickupWindow,
      pickupWindowDays,
      preferredPickupDate,
    });
    const priced = applyBillableDaysToFare(daily, billableDays, config.gst);

    const discount = await computeBookingDiscount({
      couponCode,
      customerId: req.user.id,
      bookingKind: isLocal ? "porter_local" : "porter_outstation",
      fareAmount: priced.fare,
    });

    // The tax as it will be RECORDED once the discount is applied, so the
    // booking screen shows the same GST the invoice will.
    const taxed = rebaseGstAfterDiscount(priced, discount.payableFare);

    return handleResponse(res, 200, "Coupon applied", {
      couponId: discount.coupon._id,
      code: discount.coupon.code,
      fare: priced.fare,
      discountAmount: discount.discountAmount,
      payableFare: discount.payableFare,
      couponSnapshot: discount.couponSnapshot,
      // Split so the booking screen can print lines that add up: the discount
      // comes off the taxable value, then tax applies to what remains.
      // `discountAmount` above stays the customer's total saving.
      taxableDiscount:
        Math.round((taxed.preDiscountTaxableAmount - taxed.taxableAmount) * 100) / 100,
      tax: {
        percent: taxed.gstPercent,
        amount: taxed.gstAmount,
        cgst: taxed.cgst,
        sgst: taxed.sgst,
        taxableAmount: taxed.taxableAmount,
        inclusive: taxed.gstInclusive,
      },
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/* ==========================================================================
   Booking input rules
   ==========================================================================
   `POST /parcels/create` carried no field-level validation at all: it checked
   that pickupAddress existed and then trusted every value inside it. A name
   could be "12345", the phone the rider has to call could be "abc", and a
   missing lat/lng became NaN that only surfaced as a confusing failure deep
   in the distance lookup. The city-parcel module validates with Joi before
   the controller runs; this is the same guarantee for the outstation one.
   ========================================================================== */

/** Indian mobile: 10 digits starting 6-9, with an optional +91 / 0 prefix. */
const PHONE_PATTERN = /^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/;
/** At least one letter, and nothing but letters, spaces and name punctuation. */
const PERSON_NAME_PATTERN = /^(?=.*\p{L})[\p{L}\p{M}\s.'-]+$/u;
const PINCODE_PATTERN = /^[1-9]\d{5}$/;

/**
 * Validates the person + place the rider is being sent to.
 * @returns {string|null} the message to reject with, or null when usable.
 */
function checkBookingAddress(address, label) {
  if (!address || typeof address !== "object") return `${label} is required`;

  const name = String(address.name || "").trim();
  if (name.length < 2 || name.length > 80 || !PERSON_NAME_PATTERN.test(name)) {
    return `Enter a valid ${label.toLowerCase()} name — letters only, no digits`;
  }

  const phone = String(address.phone || "").trim().replace(/[\s-]/g, "");
  if (!PHONE_PATTERN.test(phone)) {
    return `Enter a valid 10-digit ${label.toLowerCase()} phone number`;
  }

  const fullAddress = String(address.fullAddress || "").trim();
  if (fullAddress.length < 5 || fullAddress.length > 500) {
    return `${label} address looks too short to find`;
  }

  // A pin that never got set arrives as undefined and becomes NaN downstream,
  // where it reads as a routing failure rather than a missing field.
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return `Set the ${label.toLowerCase()} point on the map`;
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return `Set the ${label.toLowerCase()} point on the map`;
  }

  if (address.pincode !== undefined && String(address.pincode).trim()) {
    if (!PINCODE_PATTERN.test(String(address.pincode).trim())) {
      return `Enter a valid 6-digit ${label.toLowerCase()} pincode`;
    }
  }

  return null;
}

/**
 * Validates the end customer an outstation parcel is actually going to — the
 * label printed for the courier company to ship onward, not a place the
 * rider ever navigates to. No lat/lng gate, unlike `checkBookingAddress`:
 * nobody in this flow dispatches against this point.
 */
function checkReceiverAddress(address) {
  if (!address || typeof address !== "object") return "Receiver details are required";

  const name = String(address.name || "").trim();
  if (name.length < 2 || name.length > 80 || !PERSON_NAME_PATTERN.test(name)) {
    return "Enter a valid receiver name — letters only, no digits";
  }

  const phone = String(address.phone || "").trim().replace(/[\s-]/g, "");
  if (!PHONE_PATTERN.test(phone)) {
    return "Enter a valid 10-digit receiver phone number";
  }

  const fullAddress = String(address.fullAddress || "").trim();
  if (fullAddress.length < 5 || fullAddress.length > 500) {
    return "Receiver address looks too short to find";
  }

  const pincode = String(address.pincode || "").trim();
  if (!PINCODE_PATTERN.test(pincode)) {
    return "Enter a valid 6-digit receiver pincode";
  }

  return null;
}

const PARCEL_PAYMENT_METHODS = ["UPI", "CARD", "WALLET", "COD"];

/**
 * How long an unpaid UPI parcel stays eligible to be resumed rather than
 * duplicated — a customer who dismisses the Razorpay sheet and taps Pay
 * again within this window gets the SAME parcel row re-priced and a fresh
 * gateway order opened on it.
 */
const PARCEL_RESUMABLE_BOOKING_WINDOW_MS = () =>
  parseInt(process.env.PARCEL_RESUMABLE_BOOKING_WINDOW_MS || "3600000", 10);

export const createParcel = async (req, res) => {
  try {
    const {
      pickupAddress,
      dropAddress,
      receiverAddress,
      packageDetails,
      paymentMethod,
      courierCompany,
      courierCompanyId,
      customCourierName,
      destinationCity,
      preferredPickupDate,
      pickupTime,
      pickupWindow,
      pickupWindowDays,
      deliverySpeed,
      couponCode,
    } = req.body;

    if (!pickupAddress || !dropAddress || !packageDetails || !paymentMethod) {
      return handleResponse(res, 400, "Missing required details");
    }

    const method = String(paymentMethod).trim().toUpperCase();
    if (!PARCEL_PAYMENT_METHODS.includes(method)) {
      return handleResponse(res, 400, "Choose a valid payment method");
    }

    // The pickup person is who the rider calls and meets; the drop person
    // matters only for a local parcel, since an outstation one is
    // overwritten with the courier company below.
    const pickupProblem = checkBookingAddress(pickupAddress, "Pickup");
    if (pickupProblem) return handleResponse(res, 400, pickupProblem);

    const description = String(packageDetails.description || "").trim();
    if (description.length > 500) {
      return handleResponse(res, 400, "Package description must be under 500 characters");
    }

    const courierKey = courierCompanyId || courierCompany;
    const courierDoc = await CourierCompany.findActiveByNameOrId(courierKey);
    if (!courierDoc) {
      return handleResponse(res, 400, "Please select a valid courier company");
    }
    // For the "Other" option the customer types their own company name; the
    // platform rate still comes from the admin-managed "Other" record.
    let courier = courierDoc.name;
    if (courierDoc.isOther) {
      const typedName = String(customCourierName || "").trim();
      if (!typedName) {
        return handleResponse(res, 400, "Please enter the courier company name");
      }
      courier = typedName;
    }
    const city = String(destinationCity || "").trim();
    if (!city) {
      return handleResponse(res, 400, "Please select destination city");
    }
    const originCityName = String(pickupAddress?.city || "").trim();
    if (!originCityName) {
      return handleResponse(res, 400, "Please select the pickup city");
    }

    // One Day ("today") or Until a Date ("specific"); day-count options are retired.
    const windowValue = String(pickupWindow || "").trim() || "specific";

    const windowDaysMap = {
      today: 0,
      "7_days": 7,
      "15_days": 15,
      "30_days": 30,
      custom_days: null,
      specific: null,
    };

    let resolvedWindowDays =
      windowValue === "specific" || windowValue === "custom_days"
        ? pickupWindowDays == null || pickupWindowDays === ""
          ? null
          : Number(pickupWindowDays)
        : windowDaysMap[windowValue];

    if (windowValue === "custom_days") {
      if (!Number.isFinite(resolvedWindowDays) || resolvedWindowDays < 2) {
        return handleResponse(res, 400, "Please enter at least 2 days for custom booking");
      }
      if (resolvedWindowDays > 30) {
        return handleResponse(res, 400, "Custom booking cannot exceed 30 days");
      }
      resolvedWindowDays = Math.floor(resolvedWindowDays);
    }

    if (windowValue !== "specific" && windowValue !== "custom_days" && !Number.isFinite(resolvedWindowDays)) {
      resolvedWindowDays = windowDaysMap[windowValue] ?? 0;
    }

    const schedule = resolvePickupSchedule({
      pickupWindow: windowValue,
      preferredPickupDate,
      pickupTime,
    });
    if (schedule.error) {
      return handleResponse(res, 400, schedule.error);
    }
    const scheduledPickupAt = schedule.scheduledPickupAt;
    const scheduledPickupTime = schedule.pickupTime;
    const pickupDate = scheduledPickupAt || new Date(schedule.pickupDate);
    const pickupDay = new Date(schedule.pickupDate);
    pickupDay.setHours(0, 0, 0, 0);

    const config = await ParcelConfig.getOrCreate();
    const maxWeightKg = config.maxWeightKg;
    const weight = Number(packageDetails.weight || 0);
    if (weight <= 0 || weight > maxWeightKg) {
      return handleResponse(
        res,
        400,
        `Weight must be greater than 0 and maximum ${maxWeightKg} KG`,
      );
    }

    const allowedTypes = (config.packageTypes || [])
      .filter((t) => t?.isActive !== false)
      .map((t) => String(t.value));
    const packageType = String(packageDetails.packageType || "").trim();
    if (!packageType || (allowedTypes.length && !allowedTypes.includes(packageType))) {
      return handleResponse(res, 400, "Invalid package type");
    }

    const speedValue = String(deliverySpeed || "normal").trim().toLowerCase();
    if (!["normal", "express"].includes(speedValue)) {
      return handleResponse(res, 400, "Please select a valid delivery speed");
    }

    const parcelType =
      String(req.body.parcelType || "outstation").toLowerCase() === "local"
        ? "local"
        : "outstation";
    const isOutstation = parcelType !== "local";

    // An outstation drop is replaced with the customer-selected courier
    // company below, so validating what the client sent would reject a value
    // nobody ends up using. A local parcel really is delivered to this
    // address, so it has to hold up.
    if (!isOutstation) {
      const dropProblem = checkBookingAddress(dropAddress, "Drop");
      if (dropProblem) return handleResponse(res, 400, dropProblem);
    } else {
      // The local flow's `dropAddress` IS the end customer; outstation needs
      // this separately, since its `dropAddress` is always the courier company
      // the rider physically hands the parcel to.
      const receiverProblem = checkReceiverAddress(receiverAddress);
      if (receiverProblem) return handleResponse(res, 400, receiverProblem);
    }

    /**
     * Outstation dispatch used to be unzoned by design (see
     * services/deliveryZoneService.js). It now runs the same zone gate the
     * local City Parcel flow already used: the pickup has to resolve into a
     * zone, and that zone confines which riders are ever offered the job. The
     * drop can still be anywhere — only the pickup end is zone-gated, since
     * that's the end a rider is actually dispatched to.
     *
     * Skipped while no zone exists yet (a fresh install), same fallback every
     * other zone-gated flow uses.
     */
    let outstationZoneId = null;
    if (isOutstation && (await isZoneGatingActive())) {
      const zone = await resolveZoneForPoint(
        Number(pickupAddress.lat),
        Number(pickupAddress.lng),
      );
      if (!zone) {
        return handleResponse(
          res,
          400,
          "Pickup location is outside our serviceable zones. Please choose a pickup point inside a serviceable zone.",
        );
      }
      outstationZoneId = zone._id;
    }

    // Shared with the quote endpoint, so the price the customer was shown is
    // the price this books against.
    const firstMile = await resolveFirstMile({
      lat: Number(pickupAddress.lat),
      lng: Number(pickupAddress.lng),
      isOutstation,
    });
    if (firstMile.error) {
      return handleResponse(res, 400, firstMile.error);
    }

    const { distanceKm, nearest } = firstMile;

    // The rider physically drives the parcel to the courier company's
    // counter themselves — no address/coordinates to dispatch against, so
    // this is just the courier's name/phone for the rider to ask for at the
    // counter. lat/lng default to the pickup point as a placeholder since
    // nothing ever navigates against it.
    const resolvedDropAddress = isOutstation
      ? {
          name: courier,
          phone: courierDoc.phone || pickupAddress?.phone || "0000000000",
          fullAddress: courier,
          lat: Number(pickupAddress.lat),
          lng: Number(pickupAddress.lng),
        }
      : dropAddress;

    // The courier's own city-to-city charge — looked up here, not trusted
    // from the client, exactly as calculateFare/validateBookingCoupon do.
    let courierCityCharge = 0;
    if (isOutstation) {
      const cityCharge = await resolveCourierCityCharge({
        originCity: originCityName,
        destinationCity: city,
        courierCompanyId: courierDoc._id,
      });
      if (cityCharge.error) {
        return handleResponse(res, 400, cityCharge.error);
      }
      courierCityCharge = cityCharge.charge;
    }

    const daily = computeParcelDailyFare({ config, courierCharge: courierCityCharge, weightKg: weight, isExpress: speedValue === "express" });

    const billableDays = resolveParcelBillableDays({
      pickupWindow: windowValue,
      pickupWindowDays: resolvedWindowDays,
      preferredPickupDate: pickupDay,
    });
    const priced = applyBillableDaysToFare(daily, billableDays, config.gst);

    // Re-validated server-side against the freshly computed fare — never
    // trust a client-supplied fare for coupon math.
    let discount = null;
    if (couponCode) {
      discount = await computeBookingDiscount({
        couponCode,
        customerId: req.user.id,
        bookingKind: isOutstation ? "porter_outstation" : "porter_local",
        fareAmount: priced.fare,
      });
    }
    const payableFare = discount?.payableFare ?? priced.fare;

    // Everything about the booking except its identity, OTP and payment
    // state — shared by both the fresh-create path and the resume-in-place
    // path below.
    const parcelFields = {
      pickupAddress,
      dropAddress: resolvedDropAddress,
      receiverAddress: isOutstation
        ? {
            name: String(receiverAddress.name).trim(),
            phone: String(receiverAddress.phone).trim().replace(/[\s-]/g, ""),
            fullAddress: String(receiverAddress.fullAddress).trim(),
            city: String(receiverAddress.city || "").trim(),
            state: String(receiverAddress.state || "").trim(),
            pincode: String(receiverAddress.pincode || "").trim(),
          }
        : undefined,
      packageDetails,
      courierCompany: courier,
      courierCompanyId: courierDoc._id,
      sellerId: isOutstation ? null : nearest?.seller?._id,
      zoneId: outstationZoneId,
      parcelType,
      deliverySpeed: speedValue,
      destinationCity: city,
      preferredPickupDate: pickupDate,
      pickupWindow: windowValue,
      scheduledPickupAt,
      pickupTime: scheduledPickupTime,
      pickupWindowDays: resolvedWindowDays,
      weight,
      distance: distanceKm,
      fare: priced.fare,
      fareBreakdown: {
        baseFare: priced.baseFare,
        distanceFare: priced.distanceFare,
        weightFare: priced.weightFare,
        platformCharge: priced.platformCharge,
        companyCharge: priced.companyCharge,
        courierCharge: priced.courierCharge,
        expressCharge: priced.expressCharge,
        dailyFare: priced.dailyFare,
        billableDays: priced.billableDays,
        /**
         * The tax split, which used to be dropped on the floor here.
         *
         * `priced.fare` has always been tax-INCLUSIVE — `applyBillableDaysToFare`
         * runs `applyGst` over the multi-day total — but only the pre-tax line
         * items were copied onto the booking, so every outstation booking stored
         * `gstAmount: 0` and `taxableAmount: 0` by schema default. The customer
         * was charged the tax; the invoice printed no tax block and a zero
         * subtotal, and the admin GST report totalled outstation tax as nil.
         */
        gstPercent: priced.gstPercent,
        gstAmount: priced.gstAmount,
        cgst: priced.cgst,
        sgst: priced.sgst,
        igst: priced.igst,
        taxableAmount: priced.taxableAmount,
        gstInclusive: priced.gstInclusive,
        gstin: priced.gstin,
        // The whole-rupee-up gap (₹113.40 → ₹114). Zeroed out rather than
        // carried over when a coupon applies: `rebaseGstAfterDiscount` below
        // re-derives taxableAmount/gstAmount from `discount.payableFare`
        // directly (itself only cent-rounded, not rupee-ceiled — that's a
        // separate concern this fix doesn't reach), so the pre-discount
        // rounding gap would no longer reconcile against the post-discount
        // total if kept.
        roundOff: discount ? 0 : priced.roundOff,
        // A coupon moves the tax onto what the customer actually pays.
        ...(discount ? rebaseGstAfterDiscount(priced, discount.payableFare) : {}),
      },
      coupon: discount?.coupon?._id || null,
      couponSnapshot: discount?.couponSnapshot || null,
      discountAmount: discount?.discountAmount || 0,
    };

    let parcel = null;
    let resumed = false;
    let previousCouponId = null;

    /**
     * A cancelled or abandoned Razorpay sheet leaves the row it already
     * created sitting unpaid in the database. Tapping "Pay" again used to
     * insert a brand new Parcel every single time — one hesitant customer
     * could leave a string of duplicate REQUESTED rows behind, each with its
     * own Razorpay order.
     *
     * COD/CARD/WALLET never hit this: they activate immediately below with
     * no gateway sheet to cancel. Only a UPI retry looks for an existing
     * unpaid attempt to resume, and only resumes one that agrees on
     * customer, route, courier, destination and package — anything looser
     * risks resuming the wrong booking. Fields that could have changed
     * since the first attempt (weight, dates, price if admin edited the
     * rate card) are refreshed onto the SAME row rather than left stale.
     */
    if (method === "UPI") {
      const resumable = await Parcel.findOne({
        customerId: req.user.id,
        status: "REQUESTED",
        paymentStatus: "PENDING",
        paymentMethod: "UPI",
        parcelType,
        courierCompanyId: courierDoc._id,
        destinationCity: city,
        "pickupAddress.lat": pickupAddress.lat,
        "pickupAddress.lng": pickupAddress.lng,
        createdAt: { $gte: new Date(Date.now() - PARCEL_RESUMABLE_BOOKING_WINDOW_MS()) },
      }).sort({ createdAt: -1 });

      if (resumable) {
        previousCouponId = resumable.coupon ? String(resumable.coupon) : null;
        resumable.set(parcelFields);
        // The old order cannot be reopened once its sheet was dismissed;
        // a fresh one is requested further down regardless.
        resumable.razorpayOrderId = null;
        resumable.razorpayPaymentId = null;
        await resumable.save();
        parcel = resumable;
        resumed = true;
      }
    }

    if (!parcel) {
      // Generate 6-digit OTP code
      const otp = generateParcelOtp();
      parcel = await Parcel.create({
        customerId: req.user.id,
        ...parcelFields,
        paymentStatus: "PENDING",
        paymentMethod: method,
        codSettlement: buildInitialCodSettlement(method, payableFare),
        otp,
        status: "REQUESTED",
      });
    }

    await recordParcelEvent({
      parcelId: parcel._id,
      status: "REQUESTED",
      actor: PARCEL_EVENT_ACTOR.CUSTOMER,
      actorId: req.user.id,
      note: resumed ? "Payment retried on the same booking" : "Booking created",
    });

    // Only bump usage when this booking is newly claiming the coupon — a
    // retried payment on the SAME resumable booking with the SAME coupon
    // must not count twice.
    const newCouponId = discount?.coupon?._id ? String(discount.coupon._id) : null;
    if (newCouponId && (!resumed || previousCouponId !== newCouponId)) {
      await incrementCouponUsage({ couponId: discount.coupon._id });
    }

    /**
     * Online: open a gateway order; broadcast only once the money is
     * confirmed captured.
     *
     * Routed through `porterPaymentService`, which writes a real PorterPayment
     * row per attempt with a full status history, the instrument used, the
     * gateway's own fee, a refund trail — and, crucially, a webhook leg. The
     * previous version wrote a bare order id onto the parcel and nothing
     * else, so a customer whose app died between paying and returning had, as
     * far as this database was concerned, not paid at all.
     */
    if (method === "UPI") {
      try {
        const { payment, checkout } = await openBookingPayment({
          kind: PORTER_BOOKING_KIND.PARCEL,
          booking: parcel,
          idempotencyKey: req.headers?.["idempotency-key"] || null,
          correlationId: req.correlationId || null,
        });
        parcel.razorpayOrderId = checkout.orderId;
        await parcel.save();
        return handleResponse(res, 201, "Complete UPI payment to confirm courier", {
          parcel,
          requiresPayment: true,
          // The shape the existing booking screens already read, kept
          // verbatim so they need no coordinated change.
          razorpay: {
            keyId: checkout.keyId,
            orderId: checkout.orderId,
            amount: checkout.amount,
            currency: checkout.currency,
          },
          paymentId: String(payment._id),
        });
      } catch (payErr) {
        /**
         * The parcel is deleted rather than left behind, as before — but only
         * on the path where no gateway order was ever opened. A PorterPayment
         * row survives either way and records the failed attempt, so the
         * reason a customer could not start checkout is no longer lost.
         */
        await Parcel.findByIdAndDelete(parcel._id).catch(() => {});
        logger.error("parcel_payment_open_failed", {
          parcelId: String(parcel._id),
          message: payErr?.message,
          statusCode: payErr?.statusCode,
        });
        const status = payErr.statusCode || 500;
        return handleResponse(
          res,
          status,
          payErr.message || "Failed to start the payment",
        );
      }
    }

    /**
     * COD: no gateway step, so the search starts now. The cash is recorded
     * against the customer's own ledger when the rider actually collects it
     * at pickup, not here — nothing has been paid yet.
     */
    const resultParcel = await activateParcelAfterPayment(parcel);
    await notifyParcelRequested(resultParcel, req.user.id);

    return handleResponse(res, 201, "Courier request created successfully", {
      parcel: resultParcel,
      requiresPayment: false,
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/**
 * Verify Razorpay UPI payment for a parcel, then start rider/seller search.
 */
export const verifyParcelPayment = async (req, res) => {
  try {
    const {
      parcelId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    } = req.body || {};

    if (!parcelId) {
      return handleResponse(res, 400, "Courier ID is required");
    }

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    if (String(parcel.customerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You are not authorized for this courier");
    }

    if (String(parcel.paymentMethod).toUpperCase() !== "UPI") {
      return handleResponse(res, 400, "This courier does not require UPI payment");
    }

    if (parcel.paymentStatus === "PAID") {
      return handleResponse(res, 200, "Courier already paid", {
        parcel,
        requiresPayment: false,
      });
    }

    if (parcel.razorpayOrderId && parcel.razorpayOrderId !== razorpayOrderId) {
      return handleResponse(res, 400, "This payment belongs to another courier");
    }

    /**
     * Signature AND capture, not signature alone.
     *
     * A valid signature proves the receipt is genuine. It does not prove the
     * money was taken — an authorised-but-uncaptured payment produces a
     * perfectly valid receipt, and the old code marked the parcel PAID on it
     * and dispatched a rider.
     */
    const result = await verifyBookingReceipt({
      kind: PORTER_BOOKING_KIND.PARCEL,
      bookingId: parcel._id,
      customerId: req.user.id,
      gatewayOrderId: razorpayOrderId,
      gatewayPaymentId: razorpayPaymentId,
      signature: razorpaySignature,
      correlationId: req.correlationId || null,
      onPaid: activatePorterBookingAfterPayment,
    });

    if (result.status !== "CAPTURED" && result.status !== "PARTIALLY_REFUNDED") {
      // Genuine receipt, capture not confirmed yet. The webhook will finish
      // the job on its own, so there is nothing for the customer to redo.
      return handleResponse(res, 202, "Waiting for your bank to confirm the payment", {
        parcel: await Parcel.findById(parcel._id),
        paymentStatus: result.status,
        requiresPayment: false,
      });
    }

    const resultParcel = result.booking || (await Parcel.findById(parcel._id));

    return handleResponse(res, 200, "Payment verified. Searching for rider...", {
      parcel: resultParcel,
      requiresPayment: false,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return handleResponse(res, status, error.message);
  }
};

export const getParcelHistory = async (req, res) => {
  try {
    /**
     * A UPI booking whose Razorpay sheet was dismissed leaves a REQUESTED
     * row behind so the gateway order has something to attach to. It is not
     * a booking the customer made — nothing was paid and no rider was ever
     * sent — so it does not belong in their waybill history.
     */
    const parcels = await Parcel.find(visibleParcels({ customerId: req.user.id }))
      .populate("deliveryPartnerId", "name phone vehicleType")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return handleResponse(res, 200, "Courier history retrieved successfully", parcels);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const trackParcel = async (req, res) => {
  try {
    const parcel = await Parcel.findById(req.params.id)
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone vehicleType vehicleNumber profileImage location")
      .populate("sellerId", "shopName location")
      .populate("courierCompanyId", "name phone");

    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    /**
     * Anyone signed in used to be able to read any parcel by guessing its id,
     * which handed out the customer's name, phone, full pickup address and the
     * pickup OTP. Only the people with a reason to see it can now: the
     * customer who booked it, the rider carrying it, and admins.
     *
     * A stranger gets 404 rather than 403, so the endpoint cannot be used to
     * confirm that an id exists.
     */
    const viewerId = String(req.user?.id || "");
    const viewerRole = String(req.user?.role || "");
    const ownerId = String(parcel.customerId?._id || parcel.customerId || "");
    const riderId = String(parcel.deliveryPartnerId?._id || parcel.deliveryPartnerId || "");
    const isStaff = ["admin", "parcel_admin"].includes(viewerRole);

    if (!isStaff && viewerId !== ownerId && viewerId !== riderId) {
      return handleResponse(res, 404, "Courier not found");
    }

    const plain = parcel.toObject ? parcel.toObject() : { ...parcel };

    // The OTP is the customer's to read out at pickup; the rider verifies it
    // rather than being shown it.
    if (viewerId === riderId && viewerId !== ownerId) {
      delete plain.otp;
    }

    const deadline = getParcelPickupDeadline(plain);
    const lateEligible = canCustomerRequestLateRefund(plain);
    const lateSummary = getParcelLatePickupSummary(plain);
    plain.pickupSla = {
      minutes: String(plain.deliverySpeed || "normal").toLowerCase() === "express" ? 10 : NORMAL_PICKUP_SLA_MINUTES,
      deadlineAt: deadline,
      isLate: isNormalParcelPickupLate(plain),
      canRequestLateRefund: lateEligible.ok === true,
      lateRefundBlockReason: lateEligible.ok ? null : lateEligible.message,
      lateByMinutes: lateSummary?.lateByMinutes ?? 0,
      lateByLabel: lateSummary?.lateByLabel || null,
      acceptedAt: plain.acceptedAt || null,
    };

    // The full status history — when it was booked, accepted, picked up,
    // dropped, or cancelled, and by whom. The document only ever holds the
    // CURRENT status; this is what actually answers "what happened to it".
    const timeline = await ParcelEvent.find({ parcelId: parcel._id })
      .sort({ at: 1 })
      .lean();

    return handleResponse(res, 200, "Courier details retrieved successfully", {
      ...plain,
      timeline,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const cancelParcelByCustomer = async (req, res) => {
  try {
    const { parcelId } = req.params;
    if (!parcelId) {
      return handleResponse(res, 400, "Courier ID is required");
    }

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    if (String(parcel.customerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You are not authorized for this courier");
    }

    // Once a delivery partner has accepted, cancel is not allowed.
    if (parcel.deliveryPartnerId) {
      return handleResponse(
        res,
        409,
        "Courier cannot be cancelled after a delivery partner has accepted the request",
      );
    }

    if (!["REQUESTED", "SEARCHING"].includes(parcel.status)) {
      return handleResponse(
        res,
        409,
        "Courier cannot be cancelled after a delivery partner has accepted the request",
      );
    }

    // Atomic guard against race with rider accept.
    const updated = await Parcel.findOneAndUpdate(
      {
        _id: parcelId,
        customerId: req.user.id,
        deliveryPartnerId: null,
        status: { $in: ["REQUESTED", "SEARCHING"] },
      },
      {
        $set: {
          status: "CANCELLED",
          searchExpiresAt: null,
        },
        $unset: { searchMeta: 1 },
      },
      { new: true },
    );

    if (!updated) {
      return handleResponse(
        res,
        409,
        "Courier cannot be cancelled after a delivery partner has accepted the request",
      );
    }

    if (parcel.status === "SEARCHING") {
      cancelParcelSearch(parcel._id);
      await retractParcelBroadcast(String(parcel._id), null);
    }

    await recordParcelEvent({
      parcelId: updated._id,
      status: "CANCELLED",
      previousStatus: parcel.status,
      actor: PARCEL_EVENT_ACTOR.CUSTOMER,
      actorId: req.user.id,
      note: "Cancelled by the customer",
    });

    emitToAdmins("parcel:status:update", updated);
    emitToCustomer(updated.customerId, {
      event: "parcel:status:update",
      payload: {
        parcelId: String(updated._id),
        status: updated.status,
        parcel: updated,
      },
    });

    // Online and already paid — refund automatically. COD and never-paid
    // bookings are a no-op inside this call.
    const refund = await refundBookingPayment({
      kind: PORTER_BOOKING_KIND.PARCEL,
      bookingId: updated._id,
      reason: "Booking cancelled by customer",
      source: PORTER_PAYMENT_SOURCE.SYSTEM,
    }).catch((err) => {
      logger.error("parcel_cancel_refund_threw", {
        parcelId: String(updated._id),
        message: err?.message,
      });
      return { attempted: true, ok: false, error: err?.message || "Refund failed" };
    });

    if (refund.booking) {
      emitToAdmins("parcel:status:update", refund.booking);
      emitToCustomer(refund.booking.customerId, {
        event: "parcel:status:update",
        payload: {
          parcelId: String(refund.booking._id),
          status: "CANCELLED",
          parcel: refund.booking,
          message:
            refund.status === "REFUNDED"
              ? `₹${refund.amountRupees} has been refunded to your original payment method.`
              : "Your refund is being processed.",
        },
      });
    }

    // `result` stays parcel-shaped for existing callers (`setParcel(result)`);
    // `refund` rides along as an extra field on the same object rather than
    // changing the response envelope.
    const responseParcel = refund.booking || updated;
    const payload = responseParcel.toObject ? responseParcel.toObject() : responseParcel;
    payload.refund = refund;

    return handleResponse(res, 200, "Courier search cancelled successfully", payload);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ==========================================================================
   ADMIN CONTROLLERS
   ========================================================================== */

export const adminGetParcels = async (req, res) => {
  try {
    // Same rule as the customer's own history: an abandoned checkout is not
    // a live job, and an admin trying to assign a rider to one would be
    // dispatching against money that never moved. `?awaitingPayment=true`
    // surfaces them for support.
    await Parcel.cleanupLegacyFields();

    const filter =
      String(req.query.awaitingPayment) === "true"
        ? PARCEL_AWAITING_PAYMENT
        : visibleParcels();

    // List view only — the admin table doesn't render the OTP, the COD-QR
    // conversion sub-doc, or the internal broadcast bookkeeping, so there's
    // no reason to ship them on every row. The single-parcel detail view
    // (adminGetParcelById/trackParcel) still returns the full document.
    const parcels = await Parcel.find(filter)
      .select("-otp -codOnlineQr -searchMeta")
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone vehicleType")
      .populate("courierCompanyId", "name phone")
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();

    const settings = await ParcelConfig.getSearchSettings();
    const settledByParcelId = await getSettledParcelEarnings(
      parcels.filter((p) => p.status === "DELIVERED").map((p) => p._id),
    );
    const enriched = parcels.map((doc) => {
      const plain = doc.toObject ? doc.toObject() : { ...doc };
      const lateSummary = getParcelLatePickupSummary(plain);
      if (lateSummary) {
        plain.pickupSla = {
          minutes: lateSummary.slaMinutes,
          deadlineAt: lateSummary.deadlineAt,
          acceptedAt: lateSummary.acceptedAt,
          isLate: lateSummary.isLate,
          lateByMinutes: lateSummary.lateByMinutes,
          lateByLabel: lateSummary.lateByLabel,
          stillAwaitingPickup: lateSummary.stillAwaitingPickup,
        };
      }
      return withRiderEarningBreakdown(
        plain,
        settings,
        settledByParcelId.get(String(plain._id)) ?? null,
      );
    });

    return handleResponse(res, 200, "Couriers retrieved successfully", enriched);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Fresh single parcel for admin detail modal (includes proof images). */
export const adminGetParcelById = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const parcel = await Parcel.findById(parcelId)
      .populate("customerId", "name phone email")
      .populate("deliveryPartnerId", "name phone vehicleType vehicleNumber profileImage")
      .populate("sellerId", "name shopName phone address location")
      .populate("courierCompanyId", "name phone");

    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    const plain = parcel.toObject ? parcel.toObject() : { ...parcel };
    const lateSummary = getParcelLatePickupSummary(plain);
    if (lateSummary) {
      plain.pickupSla = {
        minutes: lateSummary.slaMinutes,
        deadlineAt: lateSummary.deadlineAt,
        acceptedAt: lateSummary.acceptedAt,
        isLate: lateSummary.isLate,
        lateByMinutes: lateSummary.lateByMinutes,
        lateByLabel: lateSummary.lateByLabel,
        stillAwaitingPickup: lateSummary.stillAwaitingPickup,
      };
    }

    const timeline = await ParcelEvent.find({ parcelId: parcel._id })
      .sort({ at: 1 })
      .lean();

    const settings = await ParcelConfig.getSearchSettings();
    const settledAmount =
      plain.status === "DELIVERED"
        ? (await getSettledParcelEarnings([plain._id])).get(String(plain._id)) ?? null
        : null;
    const riderEarningBreakdown = computeRiderParcelEarningBreakdown(plain, settings);
    if (settledAmount != null) riderEarningBreakdown.earning = settledAmount;

    return handleResponse(res, 200, "Courier retrieved successfully", {
      ...plain,
      timeline,
      riderEarningBreakdown,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Customer: request wallet compensation when Normal pickup exceeds 30 min. */
export const requestParcelLateRefund = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const reason = String(req.body?.reason || "").trim().slice(0, 500);

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }
    if (String(parcel.customerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You are not authorized for this courier");
    }

    const gate = canCustomerRequestLateRefund(parcel);
    if (!gate.ok) {
      return handleResponse(res, 409, gate.message);
    }

    const fare = roundCurrency(Number(parcel.fare) || 0);
    const lateSummary = getParcelLatePickupSummary(parcel);
    parcel.lateRefundRequest = {
      status: "requested",
      reason,
      requestedAt: new Date(),
      requestedAmount: fare,
      measuredAt: lateSummary?.measuredAt || new Date(),
      deadlineAt: lateSummary?.deadlineAt || null,
      lateByMinutes: lateSummary?.lateByMinutes || 0,
      lateByLabel: lateSummary?.lateByLabel || "",
      approvedAmount: 0,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      adminNote: "",
    };
    await parcel.save();

    emitToAdmins("parcel:late-refund:requested", {
      parcelId: String(parcel._id),
      fare,
      customerId: String(parcel.customerId),
      reason,
      lateByMinutes: lateSummary?.lateByMinutes || 0,
      lateByLabel: lateSummary?.lateByLabel || "",
    });

    await sendParcelNotification(
      parcel.customerId,
      "customer",
      "Late refund request submitted",
      "Your late pickup refund request was sent to admin. COD / fare collection is unchanged until admin decides.",
      NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
      parcel._id,
      null,
      { bodyKey: "late_refund_submitted_body" },
    );

    return handleResponse(res, 200, "Late refund request submitted", parcel);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/** Admin: approve late refund → credit customer wallet (COD still collects full cash). */
export const adminApproveParcelLateRefund = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }
    if (String(parcel.lateRefundRequest?.status || "none") !== "requested") {
      return handleResponse(res, 400, "No pending late refund request for this courier");
    }

    const fare = roundCurrency(Number(parcel.fare) || 0);
    let amount = roundCurrency(
      req.body?.amount != null ? Number(req.body.amount) : fare,
    );
    if (!(amount > 0)) {
      return handleResponse(res, 400, "Refund amount must be greater than 0");
    }
    if (fare > 0 && amount > fare) {
      amount = fare;
    }

    const credited = await creditLateRefundToCustomerWallet(
      parcel,
      amount,
      req.user.id,
    );

    parcel.lateRefundRequest.status = "approved";
    parcel.lateRefundRequest.approvedAmount = credited;
    parcel.lateRefundRequest.approvedAt = new Date();
    parcel.lateRefundRequest.approvedBy = req.user.id;
    parcel.lateRefundRequest.adminNote = String(req.body?.note || "").trim().slice(0, 500);
    parcel.markModified("lateRefundRequest");
    await parcel.save();

    // COD: do NOT change collectAmount — rider still collects full cash.
    emitToCustomer(parcel.customerId, {
      event: "parcel:status:update",
      payload: {
        parcelId: String(parcel._id),
        status: parcel.status,
        parcel,
        lateRefundApproved: true,
        lateRefundAmount: credited,
      },
    });

    await sendParcelNotification(
      parcel.customerId,
      "customer",
      "Late refund approved",
      `₹${credited.toFixed(2)} was credited to your wallet for late Normal pickup. ${
        String(parcel.paymentMethod).toUpperCase() === "COD"
          ? "COD cash collection remains the full fare."
          : ""
      }`.trim(),
      NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
      parcel._id,
      null,
      {
        bodyKey:
          String(parcel.paymentMethod).toUpperCase() === "COD"
            ? "late_refund_approved_cod"
            : "late_refund_approved_online",
        bodyVars: { amount: credited.toFixed(2) },
      },
    );

    return handleResponse(
      res,
      200,
      "Late refund approved and credited to customer wallet",
      parcel,
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminRejectParcelLateRefund = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }
    if (String(parcel.lateRefundRequest?.status || "none") !== "requested") {
      return handleResponse(res, 400, "No pending late refund request for this courier");
    }

    parcel.lateRefundRequest.status = "rejected";
    parcel.lateRefundRequest.rejectedAt = new Date();
    parcel.lateRefundRequest.rejectedBy = req.user.id;
    parcel.lateRefundRequest.adminNote = String(req.body?.note || "").trim().slice(0, 500);
    parcel.markModified("lateRefundRequest");
    await parcel.save();

    emitToCustomer(parcel.customerId, {
      event: "parcel:status:update",
      payload: {
        parcelId: String(parcel._id),
        status: parcel.status,
        parcel,
        lateRefundRejected: true,
      },
    });

    await sendParcelNotification(
      parcel.customerId,
      "customer",
      "Late refund request rejected",
      parcel.lateRefundRequest.adminNote ||
        "Your late pickup refund request was rejected by admin.",
      NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
      parcel._id,
      null,
      // adminNote is free text the admin typed, so it can't be translated —
      // only the generic fallback (no note) gets a translation key.
      parcel.lateRefundRequest.adminNote ? {} : { bodyKey: "late_refund_rejected_default" },
    );

    return handleResponse(res, 200, "Late refund request rejected", parcel);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const adminAssignRider = async (req, res) => {
  try {
    const { parcelId, riderId } = req.body;

    if (!parcelId || !riderId) {
      return handleResponse(res, 400, "Courier ID and Rider ID are required");
    }

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    if (parcel.deliveryPartnerId) {
      return handleResponse(res, 409, "Courier already has a rider assigned");
    }

    if (parcel.status === "SEARCHING") {
      cancelParcelSearch(parcelId);
      await retractParcelBroadcast(String(parcelId), null);
    }

    const rider = await Delivery.findById(riderId);
    if (!rider) {
      return handleResponse(res, 404, "Delivery partner not found");
    }

    const previousStatus = parcel.status;
    parcel.deliveryPartnerId = riderId;
    parcel.status = "ACCEPTED";
    parcel.acceptedAt = new Date();
    parcel.searchExpiresAt = null;
    parcel.searchMeta = undefined;
    // Same snapshot parcelAcceptAtomic takes on a normal accept — without it
    // computeRiderParcelEarningBreakdown has nothing to measure a payout
    // distance from, and this rider earns 0 for the job.
    const riderCoords = rider.location?.coordinates;
    if (Array.isArray(riderCoords) && riderCoords.length >= 2) {
      parcel.riderAcceptLocation = { lat: Number(riderCoords[1]), lng: Number(riderCoords[0]) };
    }
    await parcel.save();

    await recordParcelEvent({
      parcelId: parcel._id,
      status: "ACCEPTED",
      previousStatus,
      actor: PARCEL_EVENT_ACTOR.ADMIN,
      actorId: req.user.id,
      note: `Assigned to ${rider.name} by an admin`,
    });

    rider.isBusy = await syncDeliveryPartnerBusyFlag(riderId);
    await rider.save();
    // Emit socket event to the rider in real-time
    emitToDelivery(riderId, {
      event: "parcel:assigned",
      payload: parcel
    });

    emitToAdmins("parcel:status:update", parcel);

    // Notify Customer
    await sendParcelNotification(
      parcel.customerId,
      "customer",
      "Rider Assigned",
      `Delivery partner ${rider.name} has been assigned to your courier.`,
      NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
      parcel._id,
      null,
      { bodyKey: "status_accepted" },
    );

    // Notify Rider
    await sendParcelNotification(
      riderId,
      "delivery",
      "New Courier Delivery Assigned",
      `You have been assigned a new courier delivery from ${parcel.pickupAddress.fullAddress} to ${parcel.dropAddress.fullAddress}.`,
      NOTIFICATION_EVENTS.PARCEL_ASSIGNED,
      parcel._id,
      null,
      { bodyKey: "parcel_assigned_default" },
    );

    emitToCustomer(parcel.customerId, {
      event: "parcel:status:update",
      payload: {
        parcelId: String(parcel._id),
        status: "ACCEPTED",
        parcel,
      },
    });

    return handleResponse(res, 200, "Delivery partner assigned successfully", parcel);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminGetPricingConfig = async (req, res) => {
  try {
    const config = await ParcelConfig.getOrCreate();
    return handleResponse(res, 200, "Pricing config retrieved successfully", config);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Public booking options for customer Package Details form. */
export const getBookingConfig = async (req, res) => {
  try {
    const config = await ParcelConfig.getPublicBookingConfig();
    const courierCompanies = await CourierCompany.listActiveForBooking();
    return handleResponse(res, 200, "Courier booking config retrieved", {
      ...config,
      courierCompanies: (courierCompanies || []).map((c) => ({
        id: String(c._id),
        name: c.name,
        phone: c.phone || "",
        isOther: c.isOther === true,
      })),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminUpdatePricingConfig = async (req, res) => {
  try {
    const {
      fixedDeliveryCharge,
      weightCharge,
      maxWeightKg,
      expressCharge,
      riderPerKmRate,
      deliveryRadiusKm,
      packageTypes,
      packageCategories,
    } = req.body;

    const config = await ParcelConfig.getOrCreate();
    if (fixedDeliveryCharge !== undefined) {
      config.fixedDeliveryCharge = Math.max(0, Number(fixedDeliveryCharge) || 0);
    }
    if (weightCharge !== undefined) {
      config.weightCharge = Math.max(0, Number(weightCharge) || 0);
    }
    if (expressCharge !== undefined) {
      config.expressCharge = Math.max(0, Number(expressCharge) || 0);
    }
    if (maxWeightKg !== undefined) {
      const cap = Number(maxWeightKg);
      if (!(cap >= 0.1) || cap > 1000) {
        return handleResponse(res, 400, "Max weight must be between 0.1 and 1000 KG");
      }
      config.maxWeightKg = cap;
    }
    if (riderPerKmRate !== undefined) {
      config.riderPerKmRate = Math.max(0, Number(riderPerKmRate) || 0);
    }
    if (deliveryRadiusKm !== undefined) {
      config.deliveryRadiusKm = Math.min(100, Math.max(1, Number(deliveryRadiusKm)));
    }
    if (packageTypes !== undefined) {
      config.packageTypes = ParcelConfig.normalizePackageTypes(packageTypes);
    }
    if (packageCategories !== undefined) {
      config.packageCategories = ParcelConfig.normalizePackageCategories(packageCategories);
    }

    await config.save();
    const fresh = await ParcelConfig.findById(config._id).select(
      "fixedDeliveryCharge weightCharge maxWeightKg expressCharge riderPerKmRate deliveryRadiusKm packageTypes packageCategories gst createdAt updatedAt",
    );
    return handleResponse(
      res,
      200,
      "Pricing config updated successfully",
      fresh || config,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminGetReports = async (req, res) => {
  try {
    // Sums/counts done in Mongo, not by loading every parcel into Node — this
    // used to be `Parcel.find(visibleParcels())` with no projection, which
    // pulled every field of every parcel ever booked into memory just to
    // count and sum a handful of numbers.
    const match = visibleParcels();
    const [facet] = await Parcel.aggregate([
      { $match: match },
      {
        $facet: {
          totalDeliveries: [{ $count: "n" }],
          completed: [{ $match: { status: "DELIVERED" } }, { $count: "n" }],
          cancelled: [{ $match: { status: "CANCELLED" } }, { $count: "n" }],
          deliveredSums: [
            { $match: { status: "DELIVERED" } },
            {
              $group: {
                _id: null,
                revenue: { $sum: { $ifNull: ["$payableFare", "$fare"] } },
                discountGiven: { $sum: { $ifNull: ["$discountAmount", 0] } },
                courierChargeCollected: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ["$fareBreakdown.courierCharge", 0] },
                      { $max: [1, { $ifNull: ["$fareBreakdown.billableDays", 1] }] },
                    ],
                  },
                },
                preTaxRevenue: { $sum: { $ifNull: ["$fareBreakdown.taxableAmount", 0] } },
              },
            },
          ],
        },
      },
    ]);

    const totalDeliveries = facet.totalDeliveries[0]?.n || 0;
    const completed = facet.completed[0]?.n || 0;
    const cancelled = facet.cancelled[0]?.n || 0;
    const sums = facet.deliveredSums[0] || {};

    const revenue = Math.round((Number(sums.revenue) || 0) * 100) / 100;
    const totalDiscountGiven = Math.round((Number(sums.discountGiven) || 0) * 100) / 100;
    const courierChargeCollected =
      Math.round((Number(sums.courierChargeCollected) || 0) * 100) / 100;
    const preTaxRevenue = Math.round((Number(sums.preTaxRevenue) || 0) * 100) / 100;

    // Rider payout needs the haversine distance between riderAcceptLocation
    // and pickupAddress per parcel — not expressible as a Mongo $group sum —
    // so this one still loops in Node, but over only the two small fields it
    // needs rather than the full documents.
    const settings = await ParcelConfig.getSearchSettings();
    const deliveredForPayout = await Parcel.find(
      { ...match, status: "DELIVERED" },
      "riderAcceptLocation pickupAddress",
    ).lean();
    const riderPayout = Math.round(
      (deliveredForPayout.reduce(
        (sum, p) => sum + computeRiderParcelEarnings(p, settings),
        0,
      ) +
        Number.EPSILON) *
        100,
    ) / 100;
    // `revenue` above is tax-INCLUSIVE (it's `fare`/`payableFare`, the number
    // the customer actually pays). GST is the government's money, not the
    // platform's, so admin's margin has to come off the pre-tax total —
    // `fareBreakdown.taxableAmount`, which is already rebased to whatever
    // was actually collected (discount included, see rebaseGstAfterDiscount).
    const gstCollected = Math.round((revenue - preTaxRevenue + Number.EPSILON) * 100) / 100;
    // Every customer-paid charge (delivery + weight + express + the courier
    // company's own charge), minus the rider's payout — pre-tax revenue
    // already includes the courier company charge, so it's not subtracted
    // out here. GST is excluded: it's the government's money, never the
    // platform's. A coupon discount only ever reduces this, never the
    // rider's share, since riderPayout is computed off distance, not fare.
    const adminEarning = Math.round((preTaxRevenue - riderPayout + Number.EPSILON) * 100) / 100;

    return handleResponse(res, 200, "Reports retrieved successfully", {
      totalDeliveries,
      completed,
      cancelled,
      revenue,
      preTaxRevenue,
      gstCollected,
      totalDiscountGiven,
      courierChargeCollected,
      riderPerKmRate: settings.riderPerKmRate,
      riderPayout,
      adminEarning,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminGetActiveDeliveries = async (req, res) => {
  try {
    await Parcel.cleanupLegacyFields();

    // REQUESTED is in this list, which is exactly where an unpaid booking
    // sits — so the live board used to show jobs that had never been paid
    // for and that no rider would ever be dispatched to.
    const activeParcels = await Parcel.find(
      visibleParcels({
        status: {
          $in: [
            "SEARCHING",
            "REQUESTED",
            "ACCEPTED",
            "RIDER_ASSIGNED",
            "PICKUP_REACHED",
            "PICKED_UP",
            "OUT_FOR_DELIVERY",
          ],
        },
      }),
    )
      .populate("customerId", "name phone")
      .populate("deliveryPartnerId", "name phone")
      .lean();

    return handleResponse(res, 200, "Active deliveries retrieved successfully", activeParcels);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminResetAllParcelData = async (req, res) => {
  try {
    const confirm = String(req.body?.confirm || "").trim();
    if (confirm !== "RESET_PARCEL") {
      return handleResponse(
        res,
        400,
        'Send { "confirm": "RESET_PARCEL" } to wipe all courier data.',
      );
    }

    const summary = await resetAllParcelData();
    return handleResponse(res, 200, "All courier data cleared successfully", summary);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminGetRiders = async (req, res) => {
  try {
    const riders = await Delivery.find({ isVerified: true }).lean();

    // Sort riders:
    // 1. Available (online, free, parcel-ready) first
    // 2. Others next
    const sortedRiders = [...riders].sort((a, b) => {
      const aAvailable = a.isOnline && !a.isBusy && a.isParcelService;
      const bAvailable = b.isOnline && !b.isBusy && b.isParcelService;
      if (aAvailable && !bAvailable) return -1;
      if (!aAvailable && bAvailable) return 1;
      return 0;
    });

    return handleResponse(res, 200, "Verified riders retrieved successfully", sortedRiders);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ==========================================================================
   DELIVERY PARTNER CONTROLLERS
   ========================================================================== */

export const riderGetAssignedParcels = async (req, res) => {
  try {
    // Return both assigned but not yet accepted or currently in-progress parcels
    const parcels = await Parcel.find({
      deliveryPartnerId: req.user.id,
      status: { $ne: "DELIVERED" }
    })
      .select("-otp")
      .populate("customerId", "name phone")
      .populate("sellerId", "name shopName phone address location")
      .populate("courierCompanyId", "name phone")
      .sort({ createdAt: -1 })
      .lean();

    const settings = await ParcelConfig.getSearchSettings();
    const withEarnings = parcels.map((p) => withRiderEarningBreakdown(p, settings));

    return handleResponse(res, 200, "Assigned couriers retrieved successfully", withEarnings);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Road route for assigned parcel task map.
 * Query: phase=pickup|seller|agency|drop|full, originLat, originLng.
 * Rider job is pickup (user) → parcel hub seller (local) or → courier company
 * counter (outstation, no live routing needed once picked up — see
 * ParcelTaskPage.jsx, which stops requesting a route after PICKED_UP).
 */
export const getParcelRoute = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const phase = String(req.query.phase || "seller").toLowerCase();
    const originLat = parseFloat(req.query.originLat);
    const originLng = parseFloat(req.query.originLng);

    if (!Number.isFinite(originLat) || !Number.isFinite(originLng)) {
      return handleResponse(res, 400, "originLat and originLng required");
    }

    const parcel = await Parcel.findById(parcelId)
      .populate("sellerId", "location shopName")
      .populate("courierCompanyId", "name phone")
      .lean();
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    if (String(parcel.deliveryPartnerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You are not authorized for this courier");
    }

    const pickup = {
      lat: Number(parcel.pickupAddress?.lat),
      lng: Number(parcel.pickupAddress?.lng),
    };
    const drop = {
      lat: Number(parcel.dropAddress?.lat),
      lng: Number(parcel.dropAddress?.lng),
    };

    const sellerCoords = parcel.sellerId?.location?.coordinates;
    const seller =
      Array.isArray(sellerCoords) && sellerCoords.length >= 2
        ? { lat: Number(sellerCoords[1]), lng: Number(sellerCoords[0]) }
        : null;

    if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
      return handleResponse(res, 400, "Pickup location missing");
    }

    const origin = { lat: originLat, lng: originLng };
    let dest = pickup;
    const isOutstation = parcel.parcelType === "outstation" || !seller;

    if (phase === "seller" || phase === "agency") {
      if (isOutstation) {
        if (!Number.isFinite(drop.lat) || !Number.isFinite(drop.lng)) {
          return handleResponse(res, 400, "Drop location missing");
        }
        dest = drop;
      } else {
        if (!seller || !Number.isFinite(seller.lat) || !Number.isFinite(seller.lng)) {
          return handleResponse(res, 400, "Seller hub location missing");
        }
        dest = seller;
      }
    } else if (phase === "drop" || phase === "full") {
      if (!Number.isFinite(drop.lat) || !Number.isFinite(drop.lng)) {
        return handleResponse(res, 400, "Drop location missing");
      }
      dest = drop;
    }

    const route = await getCachedRoute(origin, dest, "driving", null, phase);
    return handleResponse(res, 200, "Route", { ...route, destination: dest });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const riderUpdateStatus = async (req, res) => {
  try {
    const { parcelId, status, pickupProofImage } = req.body;

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) {
      return handleResponse(res, 404, "Courier not found");
    }

    if (String(parcel.deliveryPartnerId) !== String(req.user.id)) {
      return handleResponse(res, 403, "You are not authorized for this courier");
    }

    const validTransitions = ["ACCEPTED", "RIDER_ASSIGNED", "PICKUP_REACHED", "PICKED_UP", "OUT_FOR_DELIVERY", "CANCELLED"];
    if (!validTransitions.includes(status)) {
      return handleResponse(res, 400, "Invalid status transition");
    }

    // After a rider has accepted, the parcel job cannot be cancelled.
    if (status === "CANCELLED") {
      return handleResponse(
        res,
        409,
        "Courier cannot be cancelled after a delivery partner has accepted the request",
      );
    }

    /**
     * Tapping the same step twice is a double-tap or a retried request, not
     * a second event. Answering it as a no-op keeps the timeline honest —
     * replaying the write below would record the parcel arriving somewhere
     * it had already arrived.
     */
    if (parcel.status === status) {
      return handleResponse(res, 200, "Courier status already up to date", parcel);
    }

    /**
     * The list above only says the status is a real one. This says the
     * parcel can actually get there from where it is standing.
     *
     * Without it a rider could set OUT_FOR_DELIVERY straight from ACCEPTED,
     * skipping PICKUP_REACHED and PICKED_UP — and with them the pickup OTP
     * and the proof photo, which are the only evidence the parcel ever
     * changed hands. It also let a status move backwards, writing a history
     * that described a journey the parcel never made.
     */
    if (!canParcelTransition(parcel.status, status)) {
      return handleResponse(
        res,
        409,
        parcelTransitionRefusal(parcel.status, status),
      );
    }

    // Pickup from customer requires OTP confirmation before hub-drop screen.
    if (status === "PICKED_UP") {
      const providedOtp = String(req.body?.otp || "").trim();
      if (!providedOtp) {
        return handleResponse(
          res,
          400,
          "Enter the customer OTP to confirm courier pickup",
        );
      }
      if (providedOtp !== String(parcel.otp || "").trim()) {
        return handleResponse(res, 400, "Invalid pickup OTP");
      }
      const proofUrl = String(pickupProofImage || "").trim();
      if (
        !proofUrl ||
        !(
          /^https?:\/\//i.test(proofUrl) ||
          /^data:image\//i.test(proofUrl)
        )
      ) {
        return handleResponse(
          res,
          400,
          "Upload a pickup photo proof at the customer location",
        );
      }
      parcel.pickupProofImage = proofUrl;
    }

    const previousStatus = parcel.status;

    /**
     * Pickup from the customer IS the delivery now — there is no courier-hub
     * visit to wait for, so a rider confirming PICKED_UP (OTP + photo) closes
     * the parcel out as DELIVERED in the same request. This absorbs what
     * riderCompleteDelivery used to do as a second call/screen; the pickup
     * photo doubles as the delivery proof since there is no second stop to
     * photograph anymore.
     */
    if (status === "PICKED_UP") {
      parcel.status = "DELIVERED";
      parcel.deliveryProofImage = parcel.pickupProofImage;

      let recordedCodCollection = null;
      if (isParcelCod(parcel)) {
        if (!parcel.codSettlement) parcel.codSettlement = {};
        const collectAmount = getParcelCollectAmount(parcel);
        parcel.codSettlement.collectAmount = collectAmount;
        parcel.codSettlement.riderCollectedAt = new Date();
        recordedCodCollection = collectAmount;

        // Outstation parcels have no seller hub (rider drops at a courier
        // counter, nobody logs in as one) — cash stays with the rider until
        // admin approves the deposit. A parcel actually routed to a seller
        // hub keeps that hop.
        if (parcel.sellerId) {
          parcel.codSettlement.status = "WITH_SELLER";
          parcel.codSettlement.handedToSellerAt = new Date();
        } else {
          parcel.codSettlement.status = "RIDER_HOLDING";
        }
        if (parcel.paymentStatus !== "PAID") {
          parcel.paymentStatus = "PENDING";
        }
      } else {
        parcel.paymentStatus = "PAID";
      }

      await parcel.save();

      await recordParcelEvent({
        parcelId: parcel._id,
        status: "DELIVERED",
        previousStatus,
        actor: PARCEL_EVENT_ACTOR.DELIVERY,
        actorId: parcel.deliveryPartnerId,
        note: "Picked up from customer, OTP verified — delivered",
      });

      if (recordedCodCollection) {
        await Promise.all([
          recordCodCollection({
            riderId: parcel.deliveryPartnerId,
            kind: "parcel",
            refId: parcel._id,
            amount: recordedCodCollection,
          }),
          recordPorterCodCollected({
            customerId: parcel.customerId,
            bookingKind: PORTER_BOOKING_KIND.PARCEL,
            bookingId: parcel._id,
            referenceId: `PCL-${String(parcel._id).slice(-6).toUpperCase()}`,
            amount: recordedCodCollection,
            gstAmount: parcel.fareBreakdown?.gstAmount || 0,
          }),
        ]);
      }

      try {
        await applyParcelDeliveredRiderEarning(parcel);
      } catch (earnErr) {
        console.error("[courier] rider earning credit failed:", earnErr?.message || earnErr);
      }

      const populated = await Parcel.findById(parcel._id)
        .populate("deliveryPartnerId", "name phone vehicleType vehicleNumber profileImage location")
        .populate("sellerId", "name shopName phone address location")
        .populate("courierCompanyId", "name phone");

      emitToAdmins("parcel:status:update", populated || parcel);
      emitToCustomer(parcel.customerId, {
        event: "parcel:status:update",
        payload: {
          parcelId: String(parcel._id),
          status: "DELIVERED",
          parcel: populated || parcel,
        },
      });
      if (parcel.sellerId) {
        emitToSeller(String(parcel.sellerId?._id || parcel.sellerId), {
          event: "parcel:status:update",
          payload: {
            parcelId: String(parcel._id),
            status: "DELIVERED",
            parcel: populated || parcel,
            codPending:
              isParcelCod(parcel) && parcel.codSettlement?.status === "WITH_SELLER",
          },
        });
      }

      await syncDeliveryPartnerBusyFlag(req.user.id);

      await sendParcelNotification(
        parcel.customerId,
        "customer",
        "Courier delivered",
        isParcelCod(parcel)
          ? `Your courier was picked up and delivered. COD ₹${getParcelCollectAmount(parcel)} was collected at pickup.`
          : "Your courier was picked up and delivered successfully.",
        NOTIFICATION_EVENTS.PARCEL_DELIVERED,
        parcel._id,
        null,
        {
          bodyKey: isParcelCod(parcel) ? "parcel_delivered_cod" : "parcel_delivered_body",
          bodyVars: { amount: getParcelCollectAmount(parcel) },
        },
      );

      const resultDoc = populated || parcel;
      const resultPayload = resultDoc.toObject ? resultDoc.toObject() : { ...resultDoc };
      delete resultPayload.otp;

      return handleResponse(res, 200, "Courier picked up and delivered successfully", resultPayload);
    }

    parcel.status = status;

    // OTP is only verified at customer pickup.
    await parcel.save();

    await recordParcelEvent({
      parcelId: parcel._id,
      status,
      previousStatus,
      actor: PARCEL_EVENT_ACTOR.DELIVERY,
      actorId: parcel.deliveryPartnerId,
      note: "",
    });

    const populated = await Parcel.findById(parcel._id)
      .populate("deliveryPartnerId", "name phone vehicleType vehicleNumber profileImage location")
      .populate("sellerId", "name shopName phone address location")
      .populate("courierCompanyId", "name phone");

    emitToAdmins("parcel:status:update", populated || parcel);
    emitToCustomer(parcel.customerId, {
      event: "parcel:status:update",
      payload: {
        parcelId: String(parcel._id),
        status,
        parcel: populated || parcel,
        // Share pickup OTP while captain is going to / at customer.
        otp:
          status === "PICKUP_REACHED" ||
          status === "RIDER_ASSIGNED" ||
          status === "ACCEPTED"
            ? parcel.otp
            : undefined,
      },
    });

    if (status === "CANCELLED") {
      await syncDeliveryPartnerBusyFlag(req.user.id);
    }

    // Map status to customer-friendly notification descriptions
    let msg = "";
    let msgKey = null;
    let msgVars = {};
    if (status === "ACCEPTED") msg = "Your courier delivery request has been accepted by the rider.";
    else if (status === "RIDER_ASSIGNED") msg = "Rider is on the way to pick up your courier.";
    else if (status === "PICKUP_REACHED") {
      msg = `Rider has reached your pickup location. Share pickup OTP ${parcel.otp} with the captain.`;
    }
    else if (status === "OUT_FOR_DELIVERY") msg = "Your courier has been collected and is on its way to our hub.";
    else if (status === "CANCELLED") msg = "Your courier delivery was cancelled by the rider.";
    if (status === "ACCEPTED") msgKey = "status_accepted";
    else if (status === "RIDER_ASSIGNED") msgKey = "status_rider_assigned";
    else if (status === "PICKUP_REACHED") {
      msgKey = "status_pickup_reached";
      msgVars = { otp: parcel.otp };
    } else if (status === "OUT_FOR_DELIVERY") msgKey = "status_collected";
    else if (status === "CANCELLED") msgKey = "status_cancelled_by_rider";

    await sendParcelNotification(
      parcel.customerId,
      "customer",
      status === "PICKUP_REACHED"
        ? "Share pickup OTP with captain"
        : `Courier status: ${status}`,
      msg,
      NOTIFICATION_EVENTS.PARCEL_STATUS_UPDATE,
      parcel._id,
      status,
      { bodyKey: msgKey, bodyVars: msgVars }
    );

    const resultDoc = populated || parcel;
    const resultPayload = resultDoc.toObject ? resultDoc.toObject() : { ...resultDoc };
    // Never expose OTP to the delivery partner response payload.
    delete resultPayload.otp;

    return handleResponse(res, 200, "Courier status updated successfully", resultPayload);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const riderGetEarnings = async (req, res) => {
  try {
    const completedParcels = await Parcel.find({
      deliveryPartnerId: req.user.id,
      status: "DELIVERED"
    }).lean();
    const settings = await ParcelConfig.getSearchSettings();
    const settledByParcelId = await getSettledParcelEarnings(
      completedParcels.map((p) => p._id),
    );

    const totalDeliveries = completedParcels.length;
    const deliveriesWithBreakdown = completedParcels.map((p) =>
      withRiderEarningBreakdown(p, settings, settledByParcelId.get(String(p._id)) ?? null),
    );
    const totalEarnings = deliveriesWithBreakdown.reduce(
      (sum, p) => sum + p.riderEarningBreakdown.earning,
      0,
    );
    const roundedEarnings = Math.round((totalEarnings + Number.EPSILON) * 100) / 100;

    return handleResponse(res, 200, "Rider earnings retrieved successfully", {
      totalDeliveries,
      totalEarnings: roundedEarnings,
      riderPerKmRate: settings.riderPerKmRate,
      deliveries: deliveriesWithBreakdown,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const riderGetAvailableParcels = async (req, res) => {
  try {
    const parcels = await fetchAvailableParcelsForRider(req.user.id);
    const settings = await ParcelConfig.getSearchSettings();
    const withEarnings = parcels.map((parcel) => ({
      ...parcel,
      riderPerKmRate: settings.riderPerKmRate,
      earnings: computeRiderParcelEarnings(parcel, settings),
    }));
    return handleResponse(
      res,
      200,
      withEarnings.length ? "Available couriers fetched" : "No couriers found",
      withEarnings,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const riderAcceptParcel = async (req, res) => {
  try {
    const { parcelId } = req.params;
    const idempotencyKey = req.headers?.["idempotency-key"] || req.body?.idempotencyKey;

    if (!parcelId) {
      return handleResponse(res, 400, "Courier ID is required");
    }

    const { parcel, duplicate } = await parcelAcceptAtomic(
      req.user.id,
      parcelId,
      idempotencyKey,
    );

    if (!duplicate) {
      await syncDeliveryPartnerBusyFlag(req.user.id);
    }

    const settings = await ParcelConfig.getSearchSettings();

    return handleResponse(
      res,
      200,
      duplicate ? "Courier already accepted" : "Courier accepted successfully",
      withRiderEarningBreakdown(parcel, settings),
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

export const riderRejectParcel = async (req, res) => {
  try {
    const { parcelId } = req.params;
    if (!parcelId) {
      return handleResponse(res, 400, "Courier ID is required");
    }

    // The client sends reason=timeout when the 30s window runs out on its own.
    const timeout = req.query?.reason === "timeout";
    await parcelRejectAtomic(req.user.id, parcelId, { timeout });
    return handleResponse(res, 200, "Courier offer skipped");
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/** Parcel hub sellers: assigned + in-radius searching parcels. */
export const sellerGetParcels = async (req, res) => {
  try {
    const parcels = await fetchParcelsForSeller(req.user.id);
    return handleResponse(res, 200, "Seller couriers retrieved", parcels);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

function assertSellerOwnsParcel(parcel, sellerId) {
  if (!parcel?.sellerId || String(parcel.sellerId) !== String(sellerId)) {
    const err = new Error("You are not assigned to this courier");
    err.statusCode = 403;
    throw err;
  }
}

/** Seller confirms COD cash received from rider (optional explicit step). */
export const sellerConfirmCodReceived = async (req, res) => {
  try {
    const { parcelId } = req.body;
    const parcel = await Parcel.findById(parcelId);
    if (!parcel) return handleResponse(res, 404, "Courier not found");
    assertSellerOwnsParcel(parcel, req.user.id);

    if (!isParcelCod(parcel)) {
      return handleResponse(res, 400, "This courier is not COD");
    }
    if (parcel.status !== "DELIVERED") {
      return handleResponse(res, 400, "Courier must be delivered before confirming COD cash");
    }

    if (!parcel.codSettlement) parcel.codSettlement = {};
    parcel.codSettlement.collectAmount = getParcelCollectAmount(parcel);
    parcel.codSettlement.status = "WITH_SELLER";
    parcel.codSettlement.sellerConfirmedAt = new Date();
    if (!parcel.codSettlement.handedToSellerAt) {
      parcel.codSettlement.handedToSellerAt = new Date();
    }
    await parcel.save();

    emitToAdmins("parcel:status:update", parcel);
    return handleResponse(res, 200, "COD cash confirmed with seller", parcel);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/** Seller starts Razorpay checkout to remit COD cash to admin. */
export const sellerCreateCodRemitPayment = async (req, res) => {
  try {
    const { parcelId } = req.body;
    const parcel = await Parcel.findById(parcelId);
    if (!parcel) return handleResponse(res, 404, "Courier not found");
    assertSellerOwnsParcel(parcel, req.user.id);

    if (!isParcelCod(parcel)) {
      return handleResponse(res, 400, "This courier is not COD");
    }
    if (parcel.status !== "DELIVERED") {
      return handleResponse(res, 400, "Courier must be delivered before remitting COD");
    }
    if (parcel.codSettlement?.status === "REMITTED_TO_ADMIN" || parcel.paymentStatus === "PAID") {
      return handleResponse(res, 400, "COD already remitted to admin");
    }
    if (
      parcel.codSettlement?.status !== "WITH_SELLER" &&
      parcel.codSettlement?.status !== "RIDER_HOLDING"
    ) {
      // Allow remit once delivered even if status lag; force WITH_SELLER.
      if (!parcel.codSettlement) parcel.codSettlement = {};
      parcel.codSettlement.status = "WITH_SELLER";
      parcel.codSettlement.handedToSellerAt =
        parcel.codSettlement.handedToSellerAt || new Date();
    }

    const amount = getParcelCollectAmount(parcel);
    if (amount <= 0) {
      return handleResponse(res, 400, "Invalid COD collect amount");
    }
    parcel.codSettlement.collectAmount = amount;

    const razorpay = await createParcelCodRemitRazorpayOrder(parcel, req.user.id);
    parcel.codSettlement.sellerRazorpayOrderId = razorpay.orderId;
    await parcel.save();

    return handleResponse(res, 200, "Complete Razorpay payment to remit COD to admin", {
      parcel,
      razorpay,
      collectAmount: amount,
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/** Verify seller Razorpay remittance — marks COD paid to admin. */
export const sellerVerifyCodRemitPayment = async (req, res) => {
  try {
    const {
      parcelId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    } = req.body;

    const parcel = await Parcel.findById(parcelId);
    if (!parcel) return handleResponse(res, 404, "Courier not found");
    assertSellerOwnsParcel(parcel, req.user.id);

    if (!isParcelCod(parcel)) {
      return handleResponse(res, 400, "This courier is not COD");
    }
    if (parcel.codSettlement?.status === "REMITTED_TO_ADMIN" && parcel.paymentStatus === "PAID") {
      return handleResponse(res, 200, "COD already remitted", parcel);
    }

    verifyParcelRazorpaySignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (
      parcel.codSettlement?.sellerRazorpayOrderId &&
      parcel.codSettlement.sellerRazorpayOrderId !== razorpayOrderId
    ) {
      return handleResponse(res, 400, "Razorpay order mismatch");
    }

    if (!parcel.codSettlement) parcel.codSettlement = {};
    parcel.codSettlement.status = "REMITTED_TO_ADMIN";
    parcel.codSettlement.remittedAt = new Date();
    parcel.codSettlement.sellerConfirmedAt =
      parcel.codSettlement.sellerConfirmedAt || new Date();
    parcel.codSettlement.sellerRazorpayOrderId = razorpayOrderId;
    parcel.codSettlement.sellerRazorpayPaymentId = razorpayPaymentId;
    parcel.codSettlement.collectAmount = getParcelCollectAmount(parcel);
    parcel.paymentStatus = "PAID";
    await parcel.save();

    emitToAdmins("parcel:status:update", parcel);
    emitToSeller(String(req.user.id), {
      event: "parcel:status:update",
      payload: { parcelId: String(parcel._id), status: parcel.status, parcel },
    });

    return handleResponse(res, 200, "COD remitted to admin successfully", parcel);
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};
