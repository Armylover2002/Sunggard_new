import { multiplyMoney, roundCurrency } from "./money.js";
import { applyGst, ceilGstTotal, gstBreakdownFields } from "./gst.js";

/**
 * Customer parcel fare (single day, before multi-day multiplier).
 *
 * Three independent charges, added together:
 *   - `baseFare` — the flat delivery charge (ParcelConfig.fixedDeliveryCharge),
 *     paying for the rider's pickup + drop-to-courier-counter service.
 *   - `weightFare` — ParcelConfig.weightCharge (₹/kg) × the package weight.
 *   - `courierCharge` — what the SELECTED courier company charges to actually
 *     ship the parcel from the pickup city to the destination city, looked up
 *     from the admin's Excel-uploaded rate card (see models/parcelCityRate.js
 *     and controller/parcelController.js). Passed in already resolved; this
 *     function does not do the lookup itself.
 *
 * Distance and delivery speed no longer affect price.
 * `distanceFare`/`platformCharge`/`companyCharge`/`expressCharge` are kept at
 * zero rather than removed from the shape, since fareBreakdown on the Parcel
 * model and the invoice/report code that reads it still expect those keys.
 */
export function computeParcelDailyFare({ config, courierCharge = 0, weightKg = 0 } = {}) {
  const baseFare = roundCurrency(Math.max(0, Number(config?.fixedDeliveryCharge) || 0));
  const courierFee = roundCurrency(Math.max(0, Number(courierCharge) || 0));
  const weightFare = roundCurrency(
    Math.max(0, Number(config?.weightCharge) || 0) * Math.max(0, Number(weightKg) || 0),
  );

  return {
    baseFare,
    distanceFare: 0,
    weightFare,
    platformCharge: 0,
    companyCharge: 0,
    courierCharge: courierFee,
    expressCharge: 0,
    fare: roundCurrency(baseFare + weightFare + courierFee),
  };
}

/**
 * How many billable service days a parcel booking covers.
 * - today → 1
 * - 7/15/30_days → that count
 * - specific → inclusive days from today through preferredPickupDate (capped at 31)
 */
export function resolveParcelBillableDays({
  pickupWindow,
  pickupWindowDays,
  preferredPickupDate,
} = {}) {
  const window = String(pickupWindow || "today").trim();

  if (window === "today") return 1;
  if (window === "7_days") return 7;
  if (window === "15_days") return 15;
  if (window === "30_days") return 30;
  if (window === "custom_days") {
    const customDays = Number(pickupWindowDays);
    if (Number.isFinite(customDays) && customDays > 0) {
      return Math.min(31, Math.floor(customDays));
    }
    return 1;
  }

  if (window === "specific") {
    if (!preferredPickupDate) return 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(preferredPickupDate);
    end.setHours(0, 0, 0, 0);
    if (Number.isNaN(end.getTime())) return 1;
    const diffDays = Math.round((end.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    return Math.min(31, Math.max(1, diffDays));
  }

  const days = Number(pickupWindowDays);
  if (Number.isFinite(days) && days > 0) return Math.min(31, Math.floor(days));
  return 1;
}

/**
 * Apply multi-day booking to a single-trip fare.
 * Per-day line items stay as daily rates; `fare` becomes the customer total.
 */
export function applyBillableDaysToFare(
  {
    baseFare = 0,
    distanceFare = 0,
    weightFare = 0,
    platformCharge = 0,
    companyCharge = 0,
    courierCharge = 0,
    expressCharge = 0,
    fare = 0,
  },
  billableDays = 1,
  gstConfig = null,
) {
  const days = Math.max(1, Number(billableDays) || 1);
  const dailyFare = roundCurrency(fare);
  const preTaxTotal = multiplyMoney(dailyFare, days);

  /**
   * GST is applied to the multi-day TOTAL, not to the daily rate.
   *
   * Taxing each day and summing would round the tax up to thirty-one separate
   * times on a month-long booking, so the invoice would not reconcile against
   * a single line of `total × rate`. One rounding, at the end, is both
   * correct and what an auditor expects to be able to reproduce.
   */
  /**
   * The customer never sees a paisa — the final payable amount is rounded up
   * to the next whole rupee (₹113.40 → ₹114), then the GST split is
   * re-derived from that rounded number so the invoice's
   * taxableAmount + gstAmount still reconciles to the total exactly. This is
   * the one place every screen (customer payment, driver/rider display,
   * admin reports) eventually reads `fare`/`payableFare` from, so rounding
   * it here — once — is what keeps all three in agreement.
   */
  const gst = ceilGstTotal(applyGst(preTaxTotal, gstConfig || {}));

  return {
    billableDays: days,
    dailyFare,
    // Keep daily rates in breakdown so rider payout stays one-trip based.
    baseFare: roundCurrency(baseFare),
    distanceFare: roundCurrency(distanceFare),
    weightFare: roundCurrency(weightFare),
    platformCharge: roundCurrency(platformCharge),
    companyCharge: roundCurrency(companyCharge),
    courierCharge: roundCurrency(courierCharge),
    expressCharge: roundCurrency(expressCharge),
    ...gstBreakdownFields(gst),
    fare: gst.totalAmount,
  };
}
