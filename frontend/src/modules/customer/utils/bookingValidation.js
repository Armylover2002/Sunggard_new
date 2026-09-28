/**
 * Field rules shared by the porter booking form.
 *
 * The form used to gate on `value.trim()` alone, which accepted "12345" as
 * a name, "abc" as a phone number and "1" as a pincode. The customer only
 * found out at the door, when a rider could not call them. These mirror the
 * server-side rules (the createParcel controller) so the client rejects the
 * same input the server would, with a message that names the field.
 */

/** Indian mobile: 10 digits starting 6-9, optional +91 / 0 prefix. */
export const PHONE_PATTERN = /^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/;

/**
 * At least one letter, and nothing but letters, spaces and the punctuation
 * real names carry. Unicode-aware, so non-Latin scripts still pass.
 */
export const PERSON_NAME_PATTERN = /^(?=.*\p{L})[\p{L}\p{M}\s.'-]+$/u;

export const PINCODE_PATTERN = /^[1-9]\d{5}$/;

export const NAME_MAX = 80;
export const PHONE_MAX = 15;
export const ADDRESS_MAX = 500;
export const DESCRIPTION_MAX = 500;
export const LANDMARK_MAX = 200;

/** Keeps only what a phone field should ever hold, so paste can't smuggle text in. */
export const sanitizePhoneInput = (value) =>
  String(value ?? "").replace(/[^\d+\s-]/g, "").slice(0, PHONE_MAX);

/** Strips digits as they are typed — the single most common name-field mistake. */
export const sanitizeNameInput = (value) =>
  String(value ?? "").replace(/[^\p{L}\p{M}\s.'-]/gu, "").slice(0, NAME_MAX);

export const sanitizePincodeInput = (value) =>
  String(value ?? "").replace(/\D/g, "").slice(0, 6);

/**
 * @returns {string|null} the problem, or null when the value is acceptable.
 * `label` is interpolated so one rule can serve "Sender name" and
 * "Receiver name" without duplicating the message.
 */
export function checkPersonName(value, label = "Name") {
  const name = String(value ?? "").trim();
  if (!name) return `${label} is required.`;
  if (name.length < 2) return `${label} looks too short.`;
  if (name.length > NAME_MAX) return `${label} must be under ${NAME_MAX} characters.`;
  if (!PERSON_NAME_PATTERN.test(name)) return `${label} should be letters only — no digits.`;
  return null;
}

export function checkPhone(value, label = "Phone number") {
  const phone = String(value ?? "").trim();
  if (!phone) return `${label} is required.`;
  if (!PHONE_PATTERN.test(phone.replace(/[\s-]/g, "")))
    return `Enter a valid 10-digit ${label.toLowerCase()} starting with 6-9.`;
  return null;
}

export function checkPincode(value, label = "Pincode") {
  const pin = String(value ?? "").trim();
  if (!pin) return `${label} is required.`;
  if (!PINCODE_PATTERN.test(pin)) return `Enter a valid 6-digit ${label.toLowerCase()}.`;
  return null;
}

export function checkAddressLine(value, label = "Address", { min = 5 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return `${label} is required.`;
  if (text.length < min) return `${label} looks too short to find.`;
  if (text.length > ADDRESS_MAX) return `${label} must be under ${ADDRESS_MAX} characters.`;
  return null;
}

/** A free-text place name (city, state) — letters, not a phone number. */
export function checkPlaceName(value, label = "City") {
  const text = String(value ?? "").trim();
  if (!text) return `${label} is required.`;
  if (text.length > NAME_MAX) return `${label} must be under ${NAME_MAX} characters.`;
  if (!PERSON_NAME_PATTERN.test(text)) return `Enter a valid ${label.toLowerCase()}.`;
  return null;
}

/** Runs checks in order and returns the first problem, so one toast fires. */
export function firstProblem(...checks) {
  for (const problem of checks) {
    if (problem) return problem;
  }
  return null;
}
