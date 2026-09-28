import Delivery from "../models/delivery.js";
import { distanceMeters } from "../utils/geoUtils.js";
import { isPointInPolygon } from "../utils/zoneGeometry.js";

const HAVERSINE_FALLBACK_LIMIT = () =>
  parseInt(process.env.DELIVERY_BROADCAST_HAVERSINE_LIMIT || "2000", 10);

function buildParcelDeliveryFilter() {
  return {
    isOnline: true,
    isVerified: true,
    isParcelService: true,
    isBusy: { $ne: true },
  };
}

/**
 * `zone`, when given, additionally requires the rider to belong there. Tested
 * in the same pass as the radius, so confining a broadcast to a zone costs
 * nothing beyond the point-in-polygon arithmetic.
 *
 * "Belong" mirrors the rule the pull feed and the accept gate already use
 * (see parcelWorkflowService.js): a rider with
 * a self-selected zone (`zoneIds`, one entry — see models/delivery.js) is
 * judged against that assignment, wherever they physically are; a rider with
 * none falls back to their live GPS fix. Without this, the push broadcast
 * disagreed with the pull feed and the claim — a rider merely passing through
 * a zone that is not theirs could be buzzed for it, only to be refused the
 * moment they tried to accept.
 */
function filterByHaversine(candidates, lat, lng, maxDistanceM, zone = null) {
  return candidates
    .filter((d) => {
      const c = d.location?.coordinates;
      if (!Array.isArray(c) || c.length < 2) return false;
      const [dlng, dlat] = c;
      if (!Number.isFinite(dlat) || !Number.isFinite(dlng)) return false;
      if (Math.abs(dlat) < 1e-5 && Math.abs(dlng) < 1e-5) return false;
      if (distanceMeters(dlat, dlng, lat, lng) > maxDistanceM) return false;
      if (zone) {
        const assignedZoneIds = (d.zoneIds || []).map(String);
        if (assignedZoneIds.length) {
          if (!assignedZoneIds.includes(String(zone._id))) return false;
        } else if (!isPointInPolygon(dlat, dlng, zone.points || [])) {
          return false;
        }
      }
      return true;
    })
    .map((d) => d._id.toString());
}

/**
 * Parcel-capable riders near a pickup point.
 * Includes riders who selected "parcel" or "both" (`isParcelService: true`).
 * Uses Haversine over all eligible online riders so nobody in-radius is missed
 * by geo-index quirks.
 *
 * `options.zone` narrows the result to riders standing inside that delivery
 * zone. It is opt-in: the outstation flow calls this without it and keeps the
 * unzoned reach it has always had.
 */
export async function getParcelRiderIdsNearPickup(
  lat,
  lng,
  radiusKm = 5,
  { zone = null } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const safeRadiusKm = Math.min(Math.max(Number(radiusKm) || 5, 1), 100);
  const maxDistanceM = safeRadiusKm * 1000;
  const base = buildParcelDeliveryFilter();

  try {
    // All online + verified + parcel/both + free riders with a location fix.
    const candidates = await Delivery.find({
      ...base,
      "location.coordinates.0": { $exists: true },
      "location.coordinates.1": { $exists: true },
    })
      .select("_id location zoneIds")
      .limit(HAVERSINE_FALLBACK_LIMIT())
      .lean();

    return filterByHaversine(candidates, lat, lng, maxDistanceM, zone);
  } catch (e) {
    console.warn("[deliveryNearby] parcel radius scan failed:", e.message);
    return [];
  }
}

/**
 * Every currently eligible parcel/both rider (no geo filter).
 * Used only when nobody is found inside the configured radius.
 */
export async function getAllEligibleParcelRiderIds() {
  try {
    const riders = await Delivery.find(buildParcelDeliveryFilter())
      .select("_id")
      .lean();
    return riders.map((r) => String(r._id));
  } catch (e) {
    console.warn("[deliveryNearby] all parcel riders failed:", e.message);
    return [];
  }
}
