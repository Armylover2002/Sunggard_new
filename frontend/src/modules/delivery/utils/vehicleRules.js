/**
 * Vehicle input rules for the rider app — the type options, and how a plate
 * and a driving licence are typed, shown and checked.
 *
 * The same rules signup uses, kept here so the "change my vehicle" form does
 * not drift from them. The server re-checks everything (see
 * services/riderVehicleChangeService.js); this only makes the form friendly.
 */

/** Cycle is no longer offered. */
export const VEHICLE_TYPES = [
  { value: "bike", label: "Bike" },
  { value: "scooter", label: "Scooter" },
];

export const vehicleTypeLabel = (value) =>
  ({ bike: "Bike", scooter: "Scooter", cycle: "Cycle" })[String(value || "").toLowerCase()] ||
  value ||
  "Not specified";

export const VEHICLE_PLATE_REGEX = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/;
export const DL_REGEX = /^(DL[0-9]{13}|[A-Z]{2}[0-9]{2}[0-9]{4}[0-9]{7})$/;

/** Shapes what is being typed into "KA 05 MN 8921". */
export const formatVehiclePlate = (value) => {
  const raw = String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  let plate = "";

  for (let i = 0; i < raw.length && plate.length < 10; i += 1) {
    const char = raw[i];
    const pos = plate.length;

    if (pos < 2 || (pos >= 4 && pos < 6)) {
      if (/[A-Z]/.test(char)) plate += char;
    } else if ((pos >= 2 && pos < 4) || pos >= 6) {
      if (/[0-9]/.test(char)) plate += char;
    }
  }

  if (plate.length <= 2) return plate;
  if (plate.length <= 4) return `${plate.slice(0, 2)} ${plate.slice(2)}`;
  if (plate.length <= 6) return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4)}`;
  return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4, 6)} ${plate.slice(6)}`;
};

export const normalizeVehiclePlate = (value) => String(value || "").replace(/\s/g, "").toUpperCase();

/** Shapes what is being typed into "DL-1234567890123" or the 15-character state format. */
export const formatDrivingLicense = (value) => {
  const upper = String(value || "").toUpperCase();
  if (upper.startsWith("DL")) {
    const digits = upper.slice(2).replace(/[^0-9]/g, "").slice(0, 13);
    return digits ? `DL-${digits}` : "DL-";
  }

  const raw = upper.replace(/[^A-Z0-9]/g, "");
  let dl = "";

  for (let i = 0; i < raw.length && dl.length < 15; i += 1) {
    const char = raw[i];
    const pos = dl.length;

    if (pos < 2) {
      if (/[A-Z]/.test(char)) dl += char;
    } else if (/[0-9]/.test(char)) {
      dl += char;
    }
  }

  return dl;
};

export const normalizeDrivingLicense = (value) =>
  String(value || "").replace(/[\s-]/g, "").toUpperCase();

/** A readable plate for display: "MH12AB0000" -> "MH 12 AB 0000". */
export const displayPlate = (value) => {
  const plate = normalizeVehiclePlate(value);
  return VEHICLE_PLATE_REGEX.test(plate) ? formatVehiclePlate(plate) : value || "Not assigned";
};
