import Joi from "joi";
import Setting from "../models/setting.js";
import handleResponse from "../utils/helper.js";
import { buildKey, getOrSet, getTTL, invalidate } from "../services/cacheService.js";
import { uploadToCloudinary } from "../services/mediaService.js";

/** Allowed keys for settings update (strip unknown keys) */
const ALLOWED_KEYS = [
  "appName",
  "supportEmail",
  "supportPhone",
  "currencySymbol",
  "currencyCode",
  "timezone",
  "logoUrl",
  "faviconUrl",
  "primaryColor",
  "secondaryColor",
  "companyName",
  "taxId",
  "address",
  "facebook",
  "twitter",
  "instagram",
  "linkedin",
  "youtube",
  "playStoreLink",
  "appStoreLink",
  "metaTitle",
  "metaDescription",
  "metaKeywords",
  "keywords",
  "legalContent",
];

function flattenForMongoSet(prefix, value, target) {
  if (value === undefined) return;

  const isPlainObject =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date);

  if (!isPlainObject) {
    target[prefix] = value;
    return;
  }

  const keys = Object.keys(value);
  if (!keys.length) {
    target[prefix] = value;
    return;
  }

  for (const key of keys) {
    flattenForMongoSet(`${prefix}.${key}`, value[key], target);
  }
}

/** Joi schema for validating settings update payload */
const updateSettingsSchema = Joi.object({
  appName: Joi.string().allow("").max(200),
  supportEmail: Joi.string().email().allow("").max(200),
  supportPhone: Joi.string().allow("").max(50),
  currencySymbol: Joi.string().allow("").max(10),
  currencyCode: Joi.string().allow("").max(10),
  timezone: Joi.string().allow("").max(100),
  logoUrl: Joi.string().allow("").max(2000),
  faviconUrl: Joi.string().allow("").max(2000),
  primaryColor: Joi.string().allow("").max(50),
  secondaryColor: Joi.string().allow("").max(50),
  companyName: Joi.string().allow("").max(200),
  taxId: Joi.string().allow("").max(100),
  address: Joi.string().allow("").max(500),
  facebook: Joi.string().allow("").max(500),
  twitter: Joi.string().allow("").max(500),
  instagram: Joi.string().allow("").max(500),
  linkedin: Joi.string().allow("").max(500),
  youtube: Joi.string().allow("").max(500),
  playStoreLink: Joi.string().allow("").max(500),
  appStoreLink: Joi.string().allow("").max(500),
  metaTitle: Joi.string().allow("").max(200),
  metaDescription: Joi.string().allow("").max(500),
  metaKeywords: Joi.string().allow("").max(1000),
  keywords: Joi.array().items(Joi.string().max(200)),
  legalContent: Joi.object({
    customerPrivacyPolicy: Joi.string().allow("").max(100000),
    customerTerms:         Joi.string().allow("").max(100000),
    customerAboutUs:       Joi.string().allow("").max(100000),
    deliveryPrivacyPolicy: Joi.string().allow("").max(100000),
    deliveryTerms:         Joi.string().allow("").max(100000),
    deliveryAboutUs:       Joi.string().allow("").max(100000),
  }).unknown(false),
}).unknown(false);

/**
 * GET /api/settings (public)
 * Returns current platform settings for frontend (no auth required).
 * For multi-tenant: later use req.tenantId ?? null in query.
 */
export const getPublicSettings = async (req, res) => {
  try {
    const tenantId = req.tenantId ?? null;
    const filter = tenantId
      ? { tenantId }
      : { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] };
    const cacheKey = buildKey("platform", "settings", tenantId ? String(tenantId) : "default");

    let settings = await getOrSet(
      cacheKey,
      async () => {
        const existing = await Setting.findOne(filter)
          .select(
            "appName supportEmail supportPhone currencySymbol currencyCode timezone logoUrl faviconUrl primaryColor secondaryColor legalContent createdAt",
          )
          .lean();
        return existing || null;
      },
      getTTL("settings"),
    );

    if (!settings) {
      const created = await Setting.create({ tenantId });
      settings = created.toObject();
      await invalidate("cache:platform:settings:*");
    }

    return handleResponse(res, 200, "Settings fetched successfully", settings);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * PUT /api/settings (admin only)
 * Updates platform settings. Uses upsert. Validates payload with Joi.
 */
export const updateSettings = async (req, res) => {
  try {
    const raw = req.body || {};
    const payload = {};
    for (const key of ALLOWED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        payload[key] = raw[key];
      }
    }

    const { error, value } = updateSettingsSchema.validate(payload, {
      stripUnknown: true,
    });
    if (error) {
      return handleResponse(
        res,
        400,
        error.details.map((d) => d.message).join("; "),
      );
    }
    const tenantId = req.tenantId ?? null;
    const filter = tenantId
      ? { tenantId }
      : { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] };
    const toSet = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      flattenForMongoSet(key, v, toSet);
    }
    if (Object.keys(toSet).length === 0) {
      const current = await Setting.findOne(filter).lean();
      const result = current || {};
      return handleResponse(res, 200, "Settings unchanged", result);
    }

    const settings = await Setting.findOneAndUpdate(
      filter,
      { $set: toSet },
      { new: true, upsert: true },
    );
    await invalidate("cache:platform:settings:*");

    const result = settings?.toObject?.() || settings || {};

    return handleResponse(res, 200, "Settings updated successfully", result);
  } catch (err) {
    return handleResponse(res, 500, err.message);
  }
};

/**
 * POST /api/settings/upload (admin only)
 * Uploads logo or favicon image to Cloudinary. Returns the public URL.
 * Request: multipart/form-data with field "image". Optional query ?type=logo|favicon for folder naming.
 */
export const uploadSettingsImage = async (req, res) => {
  try {
    const type = (req.query.type || "logo").toLowerCase();
    if (type !== "logo" && type !== "favicon") {
      return handleResponse(res, 400, "type must be logo or favicon");
    }

    if (req.file) {
      const url = await uploadToCloudinary(req.file.buffer, "settings", {
        mimeType: req.file.mimetype,
        resourceType: "image",
      });
      await invalidate("cache:platform:settings:*");
      return handleResponse(res, 200, "Image uploaded", { url, type });
    }

    const providedUrl = String(req.body?.url || req.body?.imageUrl || "").trim();
    if (!providedUrl || !/^https?:\/\//i.test(providedUrl)) {
      return handleResponse(res, 400, "A valid image URL is required");
    }

    await invalidate("cache:platform:settings:*");
    return handleResponse(res, 200, "Image URL accepted", { url: providedUrl, type });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
