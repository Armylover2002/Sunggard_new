import mongoose from "mongoose";
import { gstConfigSchema } from "./shared/gstSchemas.js";

export const DEFAULT_PACKAGE_TYPES = [
  { value: "document", label: "Document / Paper", isActive: true },
  { value: "food", label: "Food Items", isActive: true },
  { value: "clothes", label: "Clothes / Fabric", isActive: true },
  { value: "electronics", label: "Electronics", isActive: true },
  { value: "other", label: "Other Packets", isActive: true },
];

const packageTypeSchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

/** Segments a package category can belong to. */
export const PACKAGE_SEGMENTS = ["personal", "business"];

/** Default customer package categories grouped by Personal / Business segment. */
export const DEFAULT_PACKAGE_CATEGORIES = [
  { value: "personal_gift", label: "Gift", segment: "personal", isActive: true },
  { value: "personal_documents", label: "Personal Documents", segment: "personal", isActive: true },
  { value: "personal_clothing", label: "Clothing", segment: "personal", isActive: true },
  { value: "business_invoice", label: "Invoice / Bills", segment: "business", isActive: true },
  { value: "business_samples", label: "Product Samples", segment: "business", isActive: true },
  { value: "business_documents", label: "Business Documents", segment: "business", isActive: true },
];

const packageCategorySchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    segment: { type: String, enum: PACKAGE_SEGMENTS, default: "personal" },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const parcelConfigSchema = new mongoose.Schema(
  {
    /**
     * Flat delivery charge for an outstation booking — the whole customer
     * price (pre-tax, pre-multi-day) regardless of distance, weight or which
     * courier company the customer picked. The rider drives the parcel to the
     * customer-selected courier company themselves; there is no separate
     * distance-priced leg to charge for.
     */
    fixedDeliveryCharge: {
      type: Number,
      default: 40,
      min: 0,
    },
    /** ₹ charged per kg of package weight, added on top of fixedDeliveryCharge. */
    weightCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Heaviest package a customer may book, in kg. Enforced on every booking and quote. */
    maxWeightKg: {
      type: Number,
      default: 50,
      min: 0.1,
      max: 1000,
    },
    /** Per-km rate paid to the rider for the pickup leg (see riderAcceptLocation on Parcel). */
    riderPerKmRate: {
      type: Number,
      default: 8,
      min: 0,
    },
    /** Fixed radius (km) used to broadcast/retry a parcel to nearby riders. */
    deliveryRadiusKm: {
      type: Number,
      default: 5,
      min: 1,
      max: 100,
    },
    /** Customer "Package Details" options (admin-managed). */
    packageTypes: {
      type: [packageTypeSchema],
      default: () => DEFAULT_PACKAGE_TYPES.map((t) => ({ ...t })),
    },
    /** Customer package categories, each tied to a Personal/Business segment. */
    packageCategories: {
      type: [packageCategorySchema],
      default: () => DEFAULT_PACKAGE_CATEGORIES.map((c) => ({ ...c })),
    },
    /** GST on the outstation fare. */
    gst: { type: gstConfigSchema, default: () => ({}) },
  },
  {
    timestamps: true,
  }
);

function normalizePackageTypes(list) {
  if (!Array.isArray(list) || !list.length) {
    return DEFAULT_PACKAGE_TYPES.map((t) => ({ ...t }));
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const label = String(item?.label || "").trim();
    let value = String(item?.value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!label) continue;
    if (!value) {
      value = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label,
      isActive: item?.isActive !== false,
    });
  }
  return out.length ? out : DEFAULT_PACKAGE_TYPES.map((t) => ({ ...t }));
}

function normalizePackageCategories(list) {
  if (!Array.isArray(list)) {
    return DEFAULT_PACKAGE_CATEGORIES.map((c) => ({ ...c }));
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const label = String(item?.label || "").trim();
    const segment = item?.segment === "business" ? "business" : "personal";
    let value = String(item?.value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!label) continue;
    if (!value) {
      value = `${segment}_${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")}`;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label, segment, isActive: item?.isActive !== false });
  }
  // Empty list is allowed (admin may disable categories entirely).
  return out;
}

/**
 * Fields retired when pricing moved to a flat delivery charge (see
 * utils/parcelFare.js). Mongo keeps whatever was last written until
 * explicitly unset, so a document saved before this migration otherwise
 * carries this dead weight in every API response forever.
 */
const LEGACY_FIELDS = [
  "baseFare",
  "perKmCharge",
  // NOT weightCharge — it was legacy when this list was first written, but
  // it's a real, current field again (₹/kg weight pricing). Leaving it here
  // meant every process restart re-ran this one-time $unset and silently
  // wiped whatever the admin had just saved back to 0.
  "baseSearchRadiusKm",
  "radiusMultiplier",
  "riderSharePercent",
  "riderBaseFareSharePercent",
  "riderDistanceFareSharePercent",
  "packageDescriptionPlaceholder",
  "expressCharge",
];

// Runs the $unset at most once per process — getOrCreate is called on nearly
// every parcel request (getSearchSettings), so this must not become a
// per-call DB write once the one-time cleanup is done.
let legacyFieldsCleaned = false;

// Helper static method to get the singleton config or create default
parcelConfigSchema.statics.getOrCreate = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({
      fixedDeliveryCharge: 40,
      riderPerKmRate: 8,
      deliveryRadiusKm: 5,
      packageTypes: DEFAULT_PACKAGE_TYPES.map((t) => ({ ...t })),
      packageCategories: DEFAULT_PACKAGE_CATEGORIES.map((c) => ({ ...c })),
    });
    legacyFieldsCleaned = true;
    return config;
  }

  if (!legacyFieldsCleaned) {
    legacyFieldsCleaned = true;
    await this.collection.updateOne(
      { _id: config._id },
      { $unset: Object.fromEntries(LEGACY_FIELDS.map((f) => [f, ""])) },
    );
  }

  let dirty = false;
  if (!Array.isArray(config.packageTypes) || config.packageTypes.length === 0) {
    config.packageTypes = DEFAULT_PACKAGE_TYPES.map((t) => ({ ...t }));
    dirty = true;
  }
  // Seed defaults for docs created before categories existed.
  if (!Array.isArray(config.packageCategories)) {
    config.packageCategories = DEFAULT_PACKAGE_CATEGORIES.map((c) => ({ ...c }));
    dirty = true;
  }
  if (dirty) await config.save();
  return config;
};

parcelConfigSchema.statics.normalizePackageTypes = normalizePackageTypes;
parcelConfigSchema.statics.normalizePackageCategories = normalizePackageCategories;

parcelConfigSchema.statics.getPublicBookingConfig = async function () {
  const config = await this.getOrCreate();
  const packageTypes = (config.packageTypes || [])
    .filter((t) => t?.isActive !== false)
    .map((t) => ({ value: t.value, label: t.label }));
  const packageCategories = (config.packageCategories || [])
    .filter((c) => c?.isActive !== false)
    .map((c) => ({
      value: c.value,
      label: c.label,
      segment: c.segment === "business" ? "business" : "personal",
    }));
  return {
    packageTypes: packageTypes.length
      ? packageTypes
      : DEFAULT_PACKAGE_TYPES.map(({ value, label }) => ({ value, label })),
    packageCategories,
    maxWeightKg: config.maxWeightKg,
  };
};

parcelConfigSchema.statics.getSearchSettings = async function () {
  const config = await this.getOrCreate();
  const envRadius = parseFloat(process.env.PARCEL_SEARCH_RADIUS_KM || "5", 10);

  const deliveryRadiusKm = Math.min(
    100,
    Math.max(1, Number(config.deliveryRadiusKm) || envRadius || 5),
  );
  const riderPerKmRate = Math.max(0, Number(config.riderPerKmRate) || 0);
  const fixedDeliveryCharge = Math.max(0, Number(config.fixedDeliveryCharge) || 0);

  return {
    deliveryRadiusKm,
    riderPerKmRate,
    fixedDeliveryCharge,
  };
};

export default mongoose.model("ParcelConfig", parcelConfigSchema);
