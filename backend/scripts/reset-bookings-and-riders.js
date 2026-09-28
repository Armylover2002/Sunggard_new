#!/usr/bin/env node
/**
 * Script: Reset existing bookings and free all riders.
 *
 * Use this script to:
 *  1. Cancel (or wipe) active City Parcel and Standard Parcel bookings.
 *  2. Clear skippedBy lists so riders are not excluded from broadcasts.
 *  3. Free all riders (set isBusy: false).
 *  4. Ensure riders are online, verified, and ready to receive fresh test bookings.
 *
 * Usage:
 *   node scripts/reset-bookings-and-riders.js
 *   node scripts/reset-bookings-and-riders.js --phone 9999999999
 *   node scripts/reset-bookings-and-riders.js --wipe
 *   node scripts/reset-bookings-and-riders.js --location 28.6139,77.2090
 *   node scripts/reset-bookings-and-riders.js --keep-status
 *   node scripts/reset-bookings-and-riders.js --help
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { resetBookingsAndFreeRiders } from "../app/services/bookingResetService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });
dotenv.config(); // fallback

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    wipe: false,
    phone: null,
    makeReady: true,
    coordinates: null,
    mongoUri: process.env.MONGO_URI || null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--wipe" || arg === "--delete") {
      options.wipe = true;
    } else if (arg === "--keep-status") {
      options.makeReady = false;
    } else if (arg === "--phone" && args[i + 1]) {
      options.phone = args[++i];
    } else if (
      (arg === "--location" || arg === "--coords") &&
      args[i + 1]
    ) {
      const parts = args[++i].split(",").map((s) => parseFloat(s.trim()));
      if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        // Input is lat,lng -> GeoJSON coordinates expects [lng, lat]
        options.coordinates = [parts[1], parts[0]];
      } else {
        console.error("Invalid --location format. Use: --location <latitude>,<longitude>");
        process.exit(1);
      }
    } else if (arg === "--mongo-uri" && args[i + 1]) {
      options.mongoUri = args[++i];
    }
  }

  return options;
}

function printHelp() {
  console.log(`
===================================================================
 RESET BOOKINGS & FREE RIDERS FOR TESTING
===================================================================

This script frees all delivery partners and cancels/resets existing
bookings so you can test fresh bookings cleanly.

Available Flags:
  --wipe, --delete         Permanently delete all parcel & city parcel documents.
                           (Default: safely cancels active bookings, leaving history).
  --phone <phone>          Target only a specific rider by phone number.
  --keep-status            Only set isBusy: false without modifying isOnline,
                           isVerified, or service capability flags.
  --location <lat,lng>     Update rider coordinates (e.g. 28.6139,77.2090)
                           so geo-radius broadcast matching succeeds.
  --mongo-uri <uri>        Explicit MongoDB connection string.
  --help, -h               Show this help message.

Examples:
  node scripts/reset-bookings-and-riders.js
  node scripts/reset-bookings-and-riders.js --phone 9876543210
  node scripts/reset-bookings-and-riders.js --location 28.6139,77.2090
  node scripts/reset-bookings-and-riders.js --wipe
===================================================================
`);
}

async function main() {
  const options = parseArgs();

  if (!options.mongoUri) {
    console.error("❌ MONGO_URI is not defined in backend/.env or passed via --mongo-uri.");
    console.error("   Example: node scripts/reset-bookings-and-riders.js --mongo-uri \"mongodb+srv://...\"");
    process.exit(1);
  }

  console.log("-------------------------------------------------------------------");
  console.log(" Connecting to MongoDB...");
  console.log("-------------------------------------------------------------------");

  await mongoose.connect(options.mongoUri);
  console.log(" Connected to MongoDB successfully.\n");

  console.log(` Resetting bookings ${options.wipe ? "(MODE: FULL WIPE)" : "(MODE: CANCEL ACTIVE)"}...`);
  if (options.phone) {
    console.log(` Target rider filter: ${options.phone}`);
  }
  if (options.coordinates) {
    console.log(` Setting rider coordinates to GeoJSON: [lng=${options.coordinates[0]}, lat=${options.coordinates[1]}]`);
  }

  const result = await resetBookingsAndFreeRiders(options);

  console.log("\n===================================================================");
  console.log(" RESET SUMMARY");
  console.log("===================================================================");
  if (options.wipe) {
    console.log(`  Standard Parcels deleted:      ${result.parcelsDeleted}`);
  } else {
    console.log(`  Standard Parcels cancelled:    ${result.parcelsCancelled}`);
    console.log(`  Standard Parcel skips cleared: ${result.parcelSkipsCleared}`);
  }
  console.log(`  Booking notifications cleared: ${result.notificationsDeleted}`);
  console.log(`  Rider profiles updated:        ${result.ridersUpdated}`);

  console.log("\n===================================================================");
  console.log(" RIDER STATUS REPORT");
  console.log("===================================================================");

  if (!result.riders.length) {
    console.log("  ⚠️  No delivery partners found in the database.");
  } else {
    for (const rider of result.riders) {
      const icon = rider.readyForTesting ? "✅" : "⚠️ ";
      console.log(`\n  ${icon} [${rider.phone}] ${rider.name}`);
      console.log(`     - ID:                  ${rider.id}`);
      console.log(`     - isBusy:              ${rider.isBusy ? "BUSY (Error)" : "FREE (false)"}`);
      console.log(`     - isOnline:            ${rider.isOnline}`);
      console.log(`     - isVerified:          ${rider.isVerified}`);
      console.log(`     - isParcelService:     ${rider.isParcelService}`);
      console.log(`     - Coordinates [lng,lat]: [${rider.coordinates.join(", ")}]`);

      if (rider.readyForTesting) {
        console.log("     - Ready for test:      YES");
      } else {
        console.log("     - Ready for test:      NO");
        for (const issue of rider.issues) {
          console.log(`       * ${issue}`);
        }
      }
    }
  }

  console.log("\n===================================================================");
  console.log(" NEXT STEPS FOR TESTING FRESH BOOKING");
  console.log("===================================================================");
  console.log("  1. Create a fresh booking from the customer app or API.");
  console.log("  2. Ensure the booking pickup address is within the rider's search radius.");
  console.log("  3. The rider will now receive the broadcast or see the job in available jobs!");
  console.log("===================================================================\n");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error("\n❌ Reset script failed:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
