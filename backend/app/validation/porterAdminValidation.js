import Joi from "joi";

/**
 * Joi schemas for the porter admin forms.
 *
 * These routes previously took whatever the client sent. A letter typed into
 * a charge field reached the controller as `Number("abc") || 0` and was saved
 * as a silent zero; the pricing endpoint had no fallback at all and stored
 * `NaN`. A phone or a pincode was any string of any length.
 *
 * NOTE ON `stripUnknown`: the validate() middleware strips keys a schema does
 * not declare, so every field a controller reads must be declared here or it
 * will stop being saved.
 */

const trimmed = Joi.string().trim();

/**
 * A human name — of a company, a place, a person.
 *
 * Digits are allowed, because "Balaji 24x7" is a real name. What is rejected
 * is a value with no letter at all, which is what a phone number typed into
 * the name box looks like.
 */
const nameString = trimmed
  .min(2)
  .max(80)
  .pattern(/\p{L}/u)
  .messages({
    "string.pattern.base": "Name must contain letters, not just numbers",
    "string.min": "Name must be at least 2 characters",
    "string.max": "Name cannot exceed 80 characters",
    "string.empty": "Name is required",
  });

/** Indian mobile. Same rule the customer-facing city parcel schema uses. */
const phone = trimmed
  .pattern(/^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/)
  .messages({ "string.pattern.base": "Enter a valid 10-digit mobile number" });

/** A rupee figure. Bounded so a typo cannot set a five-crore delivery fee. */
const money = (max = 100000) => Joi.number().min(0).max(max);

/** A Mongo ObjectId string. */
const objectIdString = trimmed
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid zone selected" });

const zoneIdsArray = Joi.array().items(objectIdString);

/**
 * Courier company: informational only — a name and contact the customer
 * picks at booking, and the zones it is offered in. No address, no charges —
 * the rider physically drives the parcel there themselves.
 */
const courierBase = {
  phone: phone.allow(""),
  sortOrder: Joi.number().integer().min(0).max(9999),
  isActive: Joi.boolean(),
  zoneIds: zoneIdsArray,
  // When true, the courier is offered in every zone and zoneIds is ignored.
  allZones: Joi.boolean(),
};

export const adminCreateCourierSchema = Joi.object({
  name: nameString.required(),
  ...courierBase,
});

/** Every field optional: the form sends only what changed. */
export const adminUpdateCourierSchema = Joi.object({
  name: nameString,
  ...courierBase,
})
  .min(1)
  .messages({ "object.min": "Nothing to update" });

/**
 * Outstation rate card. Bounds mirror models/parcelConfig.js so a value that
 * clears validation cannot then fail schema validation on save.
 */
export const adminUpdateParcelPricingSchema = Joi.object({
  fixedDeliveryCharge: money(),
  weightCharge: money(),
  // Heaviest bookable package (kg). Without this key stripUnknown drops it silently.
  maxWeightKg: Joi.number().min(0.1).max(1000).messages({
    "number.base": "Max weight must be a number",
    "number.min": "Max weight must be at least 0.1 KG",
    "number.max": "Max weight cannot exceed 1000 KG",
  }),
  deliveryRadiusKm: Joi.number().min(1).max(100),
  riderPerKmRate: money(10000),
  // Passed through: the controller owns their shape, and stripping unknown
  // keys inside them would quietly drop parts of a package type.
  packageTypes: Joi.array().items(Joi.object().unknown(true)),
  packageCategories: Joi.array().items(Joi.object().unknown(true)),
})
  .min(1)
  .messages({ "object.min": "Nothing to update" });

/** Cash handed back by a rider. */
export const adminSettleCashSchema = Joi.object({
  riderId: trimmed
    .pattern(/^[a-f\d]{24}$/i)
    .required()
    .messages({ "string.pattern.base": "Select a valid rider" }),
  amount: Joi.number().greater(0).max(1000000).required().messages({
    "number.base": "Amount must be a number",
    "number.greater": "Amount must be more than 0",
  }),
  // Free text, not an enum: the service stores it verbatim as a note
  // ("Method: Cash submission"), so constraining it would break the caller.
  method: trimmed.max(60).allow(""),
});
