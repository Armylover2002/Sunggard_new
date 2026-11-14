/**
 * Starts the CourierGo API against the disposable MongoDB published by
 * `qa/mongo-server.mjs` — test tooling only.
 *
 * The production `.env` is never edited: `dotenv` runs with `override: false`,
 * so the values set on `process.env` here win. Refuses to start if the URI it
 * is handed is anything other than a local, disposable instance.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const qaDir = dirname(fileURLToPath(import.meta.url));
const uri = readFileSync(join(qaDir, ".test-uri"), "utf8").trim();

const lower = uri.toLowerCase();
if (
  lower.includes("mongodb.net") ||
  lower.includes("mongodb+srv") ||
  !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(lower)
) {
  console.error(`\n  ABORT: refusing to start against a non-disposable database: ${uri}\n`);
  process.exit(1);
}

process.env.MONGO_URI = uri;
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.PROCESS_ROLE = "api";
process.env.REDIS_ENABLED = "false";
// Local-only signing secret. Not a Razorpay credential; it only lets this
// process verify webhook payloads that this same process signed.
process.env.RAZORPAY_WEBHOOK_SECRET =
  process.env.RAZORPAY_WEBHOOK_SECRET || "qa_local_webhook_secret_do_not_use_in_prod";
process.env.JWT_SECRET = process.env.JWT_SECRET || "qa_local_jwt_secret";

console.log(
  [
    "",
    "=========================================================",
    "  COURIERGO QA API",
    `  MongoDB : ${uri}`,
    "  Kind    : in-memory replica set (DISPOSABLE)",
    "  Atlas   : NOT CONNECTED",
    `  Port    : ${process.env.PORT || 7000}`,
    "=========================================================",
    "",
  ].join("\n"),
);

await import("../index.js");
