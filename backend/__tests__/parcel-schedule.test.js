import { resolvePickupSchedule } from "../app/utils/parcelSchedule.js";

// 5 Oct 2026, 12:00 IST
const NOW = new Date("2026-10-05T06:30:00Z");

describe("courier pickup schedule", () => {
  it("One Day is dispatched immediately, with no scheduled time", () => {
    const r = resolvePickupSchedule({ pickupWindow: "today", now: NOW });
    expect(r.ok).toBe(true);
    expect(r.scheduledPickupAt).toBeNull();
  });

  it("Until a Date stores the chosen date and time in IST", () => {
    const r = resolvePickupSchedule({
      pickupWindow: "specific",
      preferredPickupDate: "2026-10-06",
      pickupTime: "09:30",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.scheduledPickupAt.toISOString()).toBe("2026-10-06T04:00:00.000Z");
  });

  it("rejects a date in the past", () => {
    const r = resolvePickupSchedule({
      pickupWindow: "specific",
      preferredPickupDate: "2026-10-04",
      pickupTime: "23:00",
      now: NOW,
    });
    expect(r.error).toMatch(/past/);
  });

  it("rejects a time less than 10 minutes away today", () => {
    const r = resolvePickupSchedule({
      pickupWindow: "specific",
      preferredPickupDate: "2026-10-05",
      pickupTime: "12:05",
      now: NOW,
    });
    expect(r.error).toMatch(/10 minutes/);
  });

  it("rejects a malformed time and removed day-count options", () => {
    expect(resolvePickupSchedule({ pickupWindow: "specific", preferredPickupDate: "2026-10-06", pickupTime: "9am", now: NOW }).error).toMatch(/time/);
    expect(resolvePickupSchedule({ pickupWindow: "custom_days", now: NOW }).error).toMatch(/One Day/);
  });
});
