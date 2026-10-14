import DeliveryZone from "../models/deliveryZone.js";
import { isPointInPolygon } from "../utils/zoneGeometry.js";

/**
 * Zone membership for the local (city parcel) delivery flow.
 *
 * Two questions get asked constantly — "may this customer book from here?" on
 * every quote, and "is this rider inside the job's zone?" on every rider poll
 * — so the active zones are held in process and the point-in-polygon test runs
 * in memory. A delivery operation has tens of zones with a few dozen corners
 * each; loading them once a minute is far cheaper than a `$geoIntersects`
 * round trip per poll, per rider.
 *
 * This is deliberately the ONLY implementation of "is this point in a zone".
 * The admin's coordinate tester goes through here too, so what an admin
 * verifies on screen is exactly what the booking gate enforces.
 *
 * Outstation parcels (`models/parcel.js`) never consult this — that flow is
 * unzoned by design.
 */

const CACHE_TTL_MS = 60_000;

let cache = { zones: null, loadedAt: 0 };

/**
 * Drops the cached zones so the next read reloads them.
 *
 * Called after an admin writes a zone. Only clears the calling process —
 * other instances (scheduler, a second API pod) pick the change up when their
 * own TTL lapses, which is the real propagation bound.
 */
export function invalidateZoneCache() {
  cache = { zones: null, loadedAt: 0 };
}

/** Active zones, from cache when warm. `points` is all the geometry needs. */
async function loadActiveZones() {
  const now = Date.now();
  if (cache.zones && now - cache.loadedAt < CACHE_TTL_MS) return cache.zones;

  const zones = await DeliveryZone.find({ isActive: true })
    .select("_id name city color points areaSqKm")
    .lean();

  cache = { zones, loadedAt: now };
  return zones;
}

/**
 * Is zone gating in force at all?
 *
 * False while no active zone exists. Without this, switching the feature on
 * before an admin has drawn anything would refuse every local booking — the
 * whole product, off, with no way for a customer to tell why. An operation
 * that draws no zones keeps the unzoned behaviour it had.
 */
export async function isZoneGatingActive() {
  const zones = await loadActiveZones();
  return zones.length > 0;
}

/** Every active zone containing the point. Zones may overlap. */
export async function zonesForPoint(lat, lng) {
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return [];

  const zones = await loadActiveZones();
  return zones.filter((zone) => isPointInPolygon(numLat, numLng, zone.points || []));
}

/**
 * Of several overlapping matches, the one to file under: the tightest
 * polygon, being the most specific description of where the point is.
 */
export function smallestZone(zones = []) {
  if (!zones.length) return null;
  return zones.reduce((smallest, zone) =>
    (zone.areaSqKm ?? Infinity) < (smallest.areaSqKm ?? Infinity) ? zone : smallest,
  );
}

/** The one zone a point is filed under, or null if it is outside them all. */
export async function resolveZoneForPoint(lat, lng) {
  return smallestZone(await zonesForPoint(lat, lng));
}

/**
 * The zone a whole trip belongs to.
 *
 * A local delivery is a job inside one serviceable area, so both ends have to
 * sit in the same zone — a rider matched to the pickup's zone would otherwise
 * be sent to a drop nobody covers. Overlaps are handled by intersecting the
 * two sets rather than comparing one resolved zone each: if the pickup is in
 * A and B while the drop is only in B, B serves them both and the trip stands.
 *
 * Returns a discriminated result, never throws, so the caller can turn each
 * outcome into the sentence the customer needs.
 */
export async function resolveTripZone(pickup, drop) {
  if (!(await isZoneGatingActive())) return { ok: true, zone: null, gated: false };

  const pickupZones = await zonesForPoint(pickup?.lat, pickup?.lng);
  if (!pickupZones.length) return { ok: false, code: "OUT_OF_ZONE", gated: true };

  const dropZones = await zonesForPoint(drop?.lat, drop?.lng);
  if (!dropZones.length) return { ok: false, code: "DROP_OUT_OF_ZONE", gated: true };

  const dropIds = new Set(dropZones.map((zone) => String(zone._id)));
  const shared = pickupZones.filter((zone) => dropIds.has(String(zone._id)));

  if (!shared.length) {
    return {
      ok: false,
      code: "ZONE_MISMATCH",
      gated: true,
      pickupZone: smallestZone(pickupZones),
      dropZone: smallestZone(dropZones),
    };
  }

  return { ok: true, zone: smallestZone(shared), gated: true };
}

/** One active zone by id, or null if it was deleted or deactivated. */
export async function getActiveZoneById(zoneId) {
  if (!zoneId) return null;
  const zones = await loadActiveZones();
  return zones.find((zone) => String(zone._id) === String(zoneId)) || null;
}

/**
 * Is this coordinate inside the given zone?
 *
 * Takes a zone id rather than a document so callers in the matching loop do
 * not each have to hold one. Returns false for an unknown id — a zone that
 * has been deleted contains nobody.
 */
export async function isPointInZoneId(zoneId, lat, lng) {
  const zone = await getActiveZoneById(zoneId);
  if (!zone) return false;

  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return false;

  return isPointInPolygon(numLat, numLng, zone.points || []);
}

/**
 * Every zone id a rider could be assigned to and still legitimately cover a
 * job: the zone the parcel was filed under, plus every other active zone that
 * contains its pickup point.
 *
 * A parcel is filed under only the *smallest* containing zone, so a rider who
 * picked an enclosing (larger) zone would never match by exact id even though
 * the pickup is inside their zone. Overlaps are real (see zonesForPoint), so
 * matching against this set instead keeps those riders in.
 */
export async function zoneIdsCoveringPickup(parcelZoneId, lat, lng) {
  const ids = new Set();
  if (parcelZoneId) ids.add(String(parcelZoneId));
  const containing = await zonesForPoint(lat, lng);
  containing.forEach((zone) => ids.add(String(zone._id)));
  return ids;
}
