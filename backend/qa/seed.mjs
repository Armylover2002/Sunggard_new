/**
 * QA base-identity seeder — test tooling only.
 *
 * Seeds ONLY the identities needed to sign in to the three apps, plus the
 * platform Settings document the invoice issuer block reads. Nothing else:
 * no bookings, no payments, no earnings, no ledger rows. Every business
 * operation and every piece of pricing/coupon/GST configuration is performed
 * through the real UI, because that is what is under test.
 *
 * Uses the real Mongoose models so schema validation, defaults and password
 * hashing hooks all run exactly as they do in the app.
 *
 * Refuses to run against anything but the disposable in-memory database.
 */

import mongoose from "mongoose";
import { testUri } from "./db.mjs";

const uri = testUri(); // aborts on a non-disposable URI

process.env.MONGO_URI = uri;
await mongoose.connect(uri);
console.log(`connected: ${uri}\n`);

const Admin = (await import("../app/models/admin.js")).default;
const Customer = (await import("../app/models/customer.js")).default;
const Delivery = (await import("../app/models/delivery.js")).default;
const Setting = (await import("../app/models/setting.js")).default;

/* ==========================================================================
   Identities
   ========================================================================== */

const ADMIN = {
  name: "QA_ADMIN",
  email: "qa_admin@sungguard-qa.com",
  password: "QaAdmin#2026",
  role: "admin",
  isVerified: true,
};

const CUSTOMERS = [
  { name: "QA User One", phone: "9000000001", email: "qa_user_01@sungguard.test" },
  { name: "QA User Two", phone: "9000000002", email: "qa_user_02@sungguard.test" },
];

/**
 * Riders are seeded APPROVED, ONLINE, parcel-enabled and with a fix in
 * Bengaluru, because those four flags are what the local dispatcher checks
 * (`isVerified`, `isParcelService`, `isOnline`, `location.coordinates`).
 * Seeding them any other way would just mean clicking through an approval
 * screen that is not the subject of this test run.
 */
const DRIVERS = [
  {
    name: "QA Driver One",
    phone: "9000000011",
    email: "qa_driver_01@sungguard.test",
    vehicleNumber: "KA01QA0001",
    location: { type: "Point", coordinates: [77.5946, 12.9716] },
  },
  {
    name: "QA Driver Two",
    phone: "9000000012",
    email: "qa_driver_02@sungguard.test",
    vehicleNumber: "KA01QA0002",
    location: { type: "Point", coordinates: [77.6, 12.975] },
  },
];

/* ==========================================================================
   Seed
   ========================================================================== */

async function seedAdmin() {
  await Admin.deleteMany({ $or: [{ email: ADMIN.email }, { name: ADMIN.name }] });
  // `new` + `save` so the password-hashing pre-save hook runs.
  const doc = new Admin(ADMIN);
  await doc.save();
  console.log(`  admin    ${ADMIN.name.padEnd(14)} ${ADMIN.email}  (password: ${ADMIN.password})`);
  return doc;
}

async function seedCustomers() {
  const out = [];
  for (const c of CUSTOMERS) {
    await Customer.deleteMany({ $or: [{ phone: c.phone }, { email: c.email }] });
    const doc = await Customer.create({
      ...c,
      role: "user",
      isVerified: true,
      isActive: true,
    });
    out.push(doc);
    console.log(`  customer ${c.name.padEnd(14)} phone ${c.phone}  (OTP 1234)`);
  }
  return out;
}

async function seedDrivers() {
  const out = [];
  for (const d of DRIVERS) {
    await Delivery.deleteMany({ $or: [{ phone: d.phone }, { email: d.email }] });
    const doc = await Delivery.create({
      ...d,
      isVerified: true, // approved by admin
      isActive: true,
      isOnline: true,
      isParcelService: true,
      lastLocationAt: new Date(),
    });
    out.push(doc);
    console.log(
      `  driver   ${d.name.padEnd(14)} phone ${d.phone}  (OTP 1234)  parcel=on online=on approved=yes`,
    );
  }
  return out;
}

/** The invoice issuer block reads this; without it invoices print a blank seller. */
async function seedSettings() {
  const existing = await Setting.findOne({});
  if (existing) {
    console.log("  settings (already present)");
    return existing;
  }
  const doc = await Setting.create({
    appName: "SunGguard QA",
    companyName: "SunGguard QA Logistics Pvt Ltd",
    address: "1 Test Street, Bengaluru, Karnataka 560001",
    supportEmail: "qa_support@sungguard.test",
    supportPhone: "9000000000",
    currencySymbol: "₹",
  });
  console.log("  settings created");
  return doc;
}

console.log("Seeding base identities into the DISPOSABLE database only:\n");
await seedAdmin();
await seedCustomers();
await seedDrivers();
await seedSettings();

console.log("\nCounts after seed:");
for (const [label, Model] of [
  ["admins", Admin],
  ["customers", Customer],
  ["deliveries", Delivery],
  ["settings", Setting],
]) {
  console.log(`  ${String(await Model.countDocuments()).padStart(4)}  ${label}`);
}

await mongoose.disconnect();
console.log("\nNo bookings, payments, earnings or ledger rows were seeded.");
