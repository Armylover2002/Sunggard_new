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
/** Same eligibility + zone rule as `filterByHaversine`, but keeps the
 * computed distance instead of discarding it, so callers that need a
 * nearest-first order don't have to look every rider's location back up a
 * second time. */
function filterByHaversineWithDistance(candidates, lat, lng, maxDistanceM, zone = null) {
  const out = [];
  for (const d of candidates) {
    const c = d.location?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const [dlng, dlat] = c;
    if (!Number.isFinite(dlat) || !Number.isFinite(dlng)) continue;
    if (Math.abs(dlat) < 1e-5 && Math.abs(dlng) < 1e-5) continue;
    const distanceM = distanceMeters(dlat, dlng, lat, lng);
    if (distanceM > maxDistanceM) continue;
    if (zone) {
      const assignedZoneIds = (d.zoneIds || []).map(String);
      if (assignedZoneIds.length) {
        if (!assignedZoneIds.includes(String(zone._id))) continue;
      } else if (!isPointInPolygon(dlat, dlng, zone.points || [])) {
        continue;
      }
    }
    out.push({ id: d._id.toString(), distanceM });
  }
  return out;
}

function filterByHaversine(candidates, lat, lng, maxDistanceM, zone = null) {
  return filterByHaversineWithDistance(candidates, lat, lng, maxDistanceM, zone).map(
    (r) => r.id,
  );
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
    console.warn("[deliveryNearby] courier radius scan failed:", e.message);
    return [];
  }
}

/**
 * Parcel-capable riders near a pickup point, nearest first — the ordering
 * the sequential offer flow dispatches in (closest rider offered first;
 * next-closest only once they reject or time out, never all at once).
 *
 * `excludeIds` drops riders already tried for this parcel (same purpose as
 * the `skippedBy` filter in `fetchAvailableParcelsForRider`), so each call
 * naturally returns the next untried candidate in first position — callers
 * don't have to track an index, just re-query with the growing exclude list
 * each time someone is skipped. Re-querying (rather than freezing the order
 * once) also means a rider who comes online, goes offline, or moves out of
 * radius between offers is reflected on the very next pick.
 */
export async function getParcelRidersNearPickupSortedByDistance(
  lat,
  lng,
  radiusKm = 5,
  { zone = null, excludeIds = [] } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const safeRadiusKm = Math.min(Math.max(Number(radiusKm) || 5, 1), 100);
  const maxDistanceM = safeRadiusKm * 1000;
  const base = buildParcelDeliveryFilter();
  const excludeSet = new Set((excludeIds || []).map(String));

  try {
    const candidates = await Delivery.find({
      ...base,
      "location.coordinates.0": { $exists: true },
      "location.coordinates.1": { $exists: true },
      ...(excludeSet.size ? { _id: { $nin: [...excludeSet] } } : {}),
    })
      .select("_id location zoneIds")
      .limit(HAVERSINE_FALLBACK_LIMIT())
      .lean();

    return filterByHaversineWithDistance(candidates, lat, lng, maxDistanceM, zone).sort(
      (a, b) => a.distanceM - b.distanceM,
    );
  } catch (e) {
    console.warn("[deliveryNearby] courier nearest-sorted scan failed:", e.message);
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
    console.warn("[deliveryNearby] all courier riders failed:", e.message);
    return [];
  }
}
