import mongoose from "mongoose";
import { DEFAULT_GST_PERCENT } from "../../utils/gst.js";

/**
 * The GST fragments shared by both porter rate cards and both booking
 * collections.
 *
 * Local and outstation are configured independently — an operation may well
 * charge different rates, or run GST on one product before the other — but
 * they must be SHAPED identically, or the admin GST report has to special-case
 * each and the invoice template has to read two different field names for the
 * same number. Defining the shape once is what keeps them interchangeable.
 */

/** Admin-editable GST settings, one copy per rate card. */
export const gstConfigSchema = new mongoose.Schema(
  {
    /**
     * Off by default. Switching GST on retroactively must be a deliberate act
     * — an operation that has been quoting tax-free fares and suddenly starts
     * adding 18% has changed its prices, and that should never happen because
     * a new field defaulted to true.
     */
    enabled: { type: Boolean, default: false },
    /** Rate applied to the pre-tax fare. */
    percent: { type: Number, default: DEFAULT_GST_PERCENT, min: 0, max: 100 },
    /**
     * True when the rate card's prices already contain the tax, so the
     * customer pays exactly the quoted fare and the tax is backed out of it
     * for the invoice. False adds the tax on top.
     */
    inclusive: { type: Boolean, default: false },
    /** The platform's own registration number, printed on every invoice. */
    gstin: { type: String, trim: true, default: "", uppercase: true },
    /** State name for the invoice header. Free text; India has 36 of them. */
    placeOfSupply: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/**
 * The tax fields carried on a booking's `fareBreakdown`.
 *
 * Stored on the booking rather than derived from the live config, because an
 * admin changing the rate must not change what an existing booking says was
 * charged. Every value is rupees, matching the rest of the breakdown.
 */
export const gstBreakdownFields = {
  /** Rate actually applied, frozen at booking time. */
  gstPercent: { type: Number, default: 0 },
  /** Total tax charged. */
  gstAmount: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  /** Pre-tax value the rate was applied to. Net of any coupon, because that
   *  is the value actually charged and therefore the value tax is due on. */
  taxableAmount: { type: Number, default: 0 },
  /** What the rate card priced before a coupon came off, so the margin the
   *  discount was funded from stays auditable. Equal to `taxableAmount` when
   *  no coupon was used. */
  preDiscountTaxableAmount: { type: Number, default: 0 },
  /** Whether the quoted fare already contained the tax. */
  gstInclusive: { type: Boolean, default: false },
  /** The registration number in force when this was sold. */
  gstin: { type: String, default: "" },
  /**
   * The gap between `taxableAmount + gstAmount` and the whole-rupee `fare`
   * actually charged (₹113.40 → ₹114 collects an extra ₹0.60 here, not as
   * tax). Kept separate from `gstAmount` on purpose — rounding the fare up
   * for collection convenience is not taxable value, and folding it into the
   * tax fields would mean remitting GST on money that was never a sale.
   */
  roundOff: { type: Number, default: 0 },
};
