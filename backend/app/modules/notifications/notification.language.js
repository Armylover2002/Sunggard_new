import mongoose from "mongoose";
import User from "../../models/customer.js";
import Delivery from "../../models/delivery.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./notification.i18n.js";

// Language is read once per recipient per notification, so keep a short cache
// rather than a query for every push. A change made in this process is applied
// at once (setCachedLanguage); other processes pick it up after the TTL.
const CACHE_TTL_MS = 10 * 60 * 1000;
// A language lookup must never hold up a notification, so give up quickly.
const LOOKUP_TIMEOUT_MS = 1500;
const cache = new Map();

const cacheKey = (role, userId) => `${role}:${String(userId)}`;

export function setCachedLanguage(role, userId, language) {
  cache.set(cacheKey(role, userId), {
    language: normalizeLanguage(language),
    until: Date.now() + CACHE_TTL_MS,
  });
}

/** Only customers and delivery partners choose a language; others get English. */
export async function getUserLanguage(userId, role) {
  if (role !== "customer" && role !== "delivery") return DEFAULT_LANGUAGE;
  if (!userId) return DEFAULT_LANGUAGE;

  const key = cacheKey(role, userId);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.language;

  let language = DEFAULT_LANGUAGE;
  try {
    if (mongoose.connection.readyState !== 1) return DEFAULT_LANGUAGE;
    const Model = role === "customer" ? User : Delivery;
    const lookup = Model.findById(userId).select("language").lean();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("language lookup timed out")), LOOKUP_TIMEOUT_MS).unref(),
    );
    const doc = await Promise.race([lookup, timeout]);
    language = normalizeLanguage(doc?.language);
  } catch {
    // A lookup failure must never stop a notification: send it in English.
    language = DEFAULT_LANGUAGE;
  }
  setCachedLanguage(role, userId, language);
  return language;
}
