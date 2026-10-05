import mongoose from "mongoose";
import User from "../../models/customer.js";
import Delivery from "../../models/delivery.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./notification.i18n.js";

// A language lookup must never hold up a notification, so give up quickly.
const LOOKUP_TIMEOUT_MS = 1500;

/**
 * The language a recipient chose, read from their own account each time.
 * No cache: the API, worker and scheduler are separate processes, and a
 * cached value would keep sending the old language after a change.
 * Only customers and delivery partners choose a language; others get English.
 */
export async function getUserLanguage(userId, role) {
  if (role !== "customer" && role !== "delivery") return DEFAULT_LANGUAGE;
  if (!userId) return DEFAULT_LANGUAGE;

  try {
    if (mongoose.connection.readyState !== 1) return DEFAULT_LANGUAGE;
    const Model = role === "customer" ? User : Delivery;
    const lookup = Model.findById(userId).select("language").lean();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("language lookup timed out")), LOOKUP_TIMEOUT_MS).unref(),
    );
    const doc = await Promise.race([lookup, timeout]);
    return normalizeLanguage(doc?.language);
  } catch {
    // A lookup failure must never stop a notification: send it in English.
    return DEFAULT_LANGUAGE;
  }
}
