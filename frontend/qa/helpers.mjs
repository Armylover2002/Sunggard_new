/**
 * Playwright helpers for the CourierGo QA run — test tooling only.
 *
 * Every flow under test drives the real UI in a real Chromium. These helpers
 * only cover sign-in and a few generic waits; nothing here fakes a business
 * operation.
 */

import { chromium } from "playwright";

export const APP = "http://localhost:5173";
export const API = "http://localhost:7000";

export const ADMIN = { email: "qa_admin@couriergo-qa.com", password: "QaAdmin#2026" };
export const USER_01 = { name: "QA_USER_01", phone: "9000000001" };
export const USER_02 = { name: "QA_USER_02", phone: "9000000002" };
export const DRIVER_01 = { name: "QA_DRIVER_01", phone: "9000000011" };
export const DRIVER_02 = { name: "QA_DRIVER_02", phone: "9000000012" };
export const OTP = "1234";

export const money = (n) => Math.round(Number(n) * 100) / 100;

export async function launch({ headless = true } = {}) {
  return chromium.launch({ headless });
}

/** Bengaluru — pickup. The rider fixtures are seeded within a few km. */
export const GEO_PICKUP = { latitude: 12.9716, longitude: 77.5946 };
/** ~4 km away, so the trip is comfortably inside the 30 km local cap. */
export const GEO_DROP = { latitude: 12.9352, longitude: 77.6245 };

/**
 * A fresh isolated context — no cookies or storage shared between roles.
 * Geolocation is granted and pinned, because the booking screens ask the
 * browser where the customer is and a headless context refuses by default.
 */
export async function newCtx(browser, label = "ctx", geo = GEO_PICKUP) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["geolocation"],
    geolocation: geo,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${label}] pageerror: ${e.message}`));
  return { ctx, page };
}

/** Read a field the app stored on login, to prove the session is real. */
export async function tokenOf(page) {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const k = keys.find((x) => /token/i.test(x));
    return k ? { key: k, value: String(localStorage.getItem(k)).slice(0, 18) + "…" } : null;
  });
}

/* ==========================================================================
   Sign-in
   ========================================================================== */

export async function loginAdmin(page) {
  await page.goto(`${APP}/admin/auth`, { waitUntil: "networkidle" });
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  // Two controls read "SIGN IN": a mode tab and the form's submit. The last
  // one in DOM order is the submit button.
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/admin/login") && r.request().method() === "POST",
      { timeout: 30000 },
    ),
    page.getByRole("button", { name: /^sign in$/i }).last().click(),
  ]);
  if (!resp.ok()) {
    throw new Error(`admin login HTTP ${resp.status()}: ${(await resp.text()).slice(0, 160)}`);
  }
  await page.waitForURL(/\/admin(?!\/auth)/, { timeout: 30000 });
  return page.url();
}

/**
 * Phone + OTP sign-in, shared by the customer and rider apps.
 * OTP is the app's mock code; no SMS is sent anywhere.
 */
async function loginByOtp(page, startUrl, phone, expectUrl) {
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  const phoneBox = page
    .locator('input[type="tel"], input[inputmode="numeric"], input[name*="phone" i]')
    .first();
  await phoneBox.waitFor({ state: "visible", timeout: 20000 });
  await phoneBox.fill(phone);

  await page
    .getByRole("button", { name: /login now|send|code|continue|next|get otp/i })
    .last()
    .click();
  await page.waitForTimeout(1500);

  // OTP may be one box or one-per-digit.
  const otpBoxes = page.locator(
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[maxlength="1"]',
  );
  const count = await otpBoxes.count();
  if (count > 1) {
    for (let i = 0; i < Math.min(count, OTP.length); i++) {
      await otpBoxes.nth(i).fill(OTP[i]);
    }
  } else {
    const single = count === 1 ? otpBoxes.first() : page.locator('input[type="tel"]').last();
    await single.fill(OTP);
  }

  // The rider app gates the verify button behind a terms checkbox.
  const consent = page.locator('input[type="checkbox"]');
  if ((await consent.count()) > 0 && !(await consent.first().isChecked())) {
    await consent.first().check({ force: true });
  }

  await page
    .getByRole("button", { name: /verify|confirm|submit|continue|sign in/i })
    .first()
    .click()
    .catch(() => {});

  await page.waitForURL(expectUrl, { timeout: 30000 });
  return page.url();
}

export async function loginCustomer(page, who = USER_01) {
  return loginByOtp(page, `${APP}/login`, who.phone, (u) => !/\/login/.test(u.toString()));
}

export async function loginDriver(page, who = DRIVER_01) {
  return loginByOtp(page, `${APP}/delivery/auth`, who.phone, (u) =>
    /\/delivery\/(?!auth)/.test(u.toString()),
  );
}

/* ==========================================================================
   Small utilities
   ========================================================================== */

export async function shot(page, name) {
  await page.screenshot({ path: `qa/shots/${name}.png`, fullPage: false });
  return `qa/shots/${name}.png`;
}

export function pass(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ""}`);
}
export function fail(label, extra = "") {
  console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
}


/* ==========================================================================
   Local (City Parcel) booking wizard: FROM -> TO -> WHAT -> PAY
   ========================================================================== */

export const RECEIVER = { name: "QA Receiver One", phone: "9000000021" };

async function fillPerson(page, f) {
  if (f.name !== undefined) await page.locator('input[placeholder="Full name"]').fill(f.name);
  if (f.phone !== undefined)
    await page.locator('input[placeholder="+91 00000 00000"]').fill(f.phone);
  if (f.flat !== undefined)
    await page.locator('textarea[placeholder="Flat no, building, floor"]').fill(f.flat);
  if (f.landmark !== undefined)
    await page.locator('input[placeholder="Near City Mall"]').fill(f.landmark);
}

async function continueStep(page, label) {
  const btn = page.getByRole("button", { name: /^continue$/i }).last();
  await btn.waitFor({ state: "visible", timeout: 20000 });
  for (let i = 0; i < 40 && !(await btn.isEnabled()); i++) await page.waitForTimeout(500);
  if (!(await btn.isEnabled())) {
    throw new Error(`CONTINUE disabled at ${label}`);
  }
  await btn.click();
  await page.waitForTimeout(1800);
}

/**
 * Pick a destination with the Google Places box.
 * The widget is Google's own `.pac-container`; it commits on keyboard
 * selection, which is far steadier than clicking a floating list.
 */
export async function setDestination(page, query = "Koramangala Bengaluru") {
  const search = page.locator('input[placeholder="Search for an area, building or landmark"]');
  await search.click();
  await search.type(query, { delay: 90 });
  await page.waitForTimeout(3000);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 24; i++) {
    if (!/TAP THE MAP TO DROP A PIN/i.test(await page.locator("body").innerText())) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** Read the fare panel the customer is actually looking at. */
export async function readQuotePanel(page) {
  return page.evaluate(() => {
    const rows = {};
    document.querySelectorAll("div").forEach((d) => {
      if (d.children.length !== 2) return;
      const k = (d.children[0].textContent || "").trim();
      const v = (d.children[1].textContent || "").trim();
      if (k && /^-?₹/.test(v) && k.length < 40) rows[k] = v;
    });
    const body = document.body.innerText;
    const total = body.match(/Total\s*₹\s*([\d,]+\.?\d*)/i);
    return { rows, total: total ? Number(total[1].replace(/,/g, "")) : null };
  });
}

/**
 * Drive the whole local booking wizard.
 * Stops on the PAY screen and hands back the page so the caller can read the
 * fare panel, apply a coupon and choose how to pay.
 */
export async function bookLocalToPayStep(page, { weightKg = 2, destination, packageType = "Documents" } = {}) {
  await page.goto(`${APP}/parcel/local`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // STEP 1 — FROM. Geolocation has already pinned the map and prefilled sender.
  await fillPerson(page, { flat: "QA Pickup Flat", landmark: "QA Pickup Landmark" });
  await continueStep(page, "FROM");

  // STEP 2 — TO
  if (!(await setDestination(page, destination || "Koramangala Bengaluru"))) {
    throw new Error("destination pin never resolved");
  }
  await fillPerson(page, {
    name: RECEIVER.name,
    phone: RECEIVER.phone,
    flat: "QA Drop Flat",
    landmark: "QA Drop Landmark",
  });
  await continueStep(page, "TO");

  // STEP 3 — WHAT. Package type is a chip; weight is a decimal text input,
  // not a number input, so it has to be matched on inputmode.
  await page
    .locator("button")
    .filter({ hasText: new RegExp("^" + packageType + "$", "i") })
    .first()
    .click();
  await page.waitForTimeout(300);
  const weightBox = page.locator('input[inputmode="decimal"]').first();
  await weightBox.waitFor({ state: "visible", timeout: 15000 });
  await weightBox.fill(String(weightKg));
  await page
    .locator('input[placeholder="Keys, documents, a birthday gift..."]')
    .fill("QA test parcel");
  await page.waitForTimeout(400);
  await continueStep(page, "WHAT");

  await page.waitForTimeout(2500);
  return page;
}

