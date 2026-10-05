/**
 * Pickup schedule for a courier booking.
 *
 * Two choices only:
 *   - "today"    → One Day: dispatched as soon as the booking is paid.
 *   - "specific" → Until a date: the rider request goes out at the date and
 *                  time the customer picked, not before.
 *
 * Dates are YYYY-MM-DD and times are HH:mm (24h), both in India time (IST).
 */
const IST_OFFSET = "+05:30";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const MIN_SCHEDULE_LEAD_MS = 10 * 60 * 1000;
export const MAX_SCHEDULE_DAYS = 30;

/** Today's date in IST as YYYY-MM-DD. */
export function istDateString(at = new Date()) {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function resolvePickupSchedule({
  pickupWindow,
  preferredPickupDate,
  pickupTime,
  now = new Date(),
} = {}) {
  if (pickupWindow === "today") {
    return {
      ok: true,
      scheduledPickupAt: null,
      pickupDate: istDateString(now),
      pickupTime: "",
    };
  }

  if (pickupWindow !== "specific") {
    return { error: "Choose One Day or a specific pickup date" };
  }

  const dateStr = String(preferredPickupDate || "").slice(0, 10);
  if (!DATE_PATTERN.test(dateStr)) {
    return { error: "Please select a valid pickup date" };
  }

  const time = String(pickupTime || "").trim();
  if (!TIME_PATTERN.test(time)) {
    return { error: "Please select a valid pickup time" };
  }

  const scheduledPickupAt = new Date(`${dateStr}T${time}:00${IST_OFFSET}`);
  if (Number.isNaN(scheduledPickupAt.getTime())) {
    return { error: "Please select a valid pickup date and time" };
  }

  if (dateStr < istDateString(now)) {
    return { error: "Pickup date cannot be in the past" };
  }
  if (scheduledPickupAt.getTime() - now.getTime() < MIN_SCHEDULE_LEAD_MS) {
    return { error: "Pickup time must be at least 10 minutes from now" };
  }
  if (scheduledPickupAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS) {
    return { error: `Pickup cannot be more than ${MAX_SCHEDULE_DAYS} days ahead` };
  }

  return { ok: true, scheduledPickupAt, pickupDate: dateStr, pickupTime: time };
}
