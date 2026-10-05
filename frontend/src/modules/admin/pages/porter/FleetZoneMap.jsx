import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Polygon, Marker, InfoWindow } from "@react-google-maps/api";
import {
  MapPin,
  Loader2,
  RotateCw,
  Radio,
  Users,
  Layers,
  Phone,
  Clock,
  Pause,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { useMapsLoader, hasMapsKey } from "@core/maps/useMapsLoader";
import Card from "@shared/components/ui/Card";
import PageHeader from "@shared/components/ui/PageHeader";
import StatCard from "@shared/components/ui/StatCard";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminDeliveryApi } from "../../services/api/deliveryApi";
import { adminPorterApi } from "../../services/api/porterApi";
import { cn } from "@/lib/utils";

/**
 * Live rider positions plotted against delivery zones.
 *
 * Billing note: the Google Maps script is loaded exactly once for the whole
 * admin app, through `useMapsLoader()` (see core/maps/useMapsLoader.js) — this
 * page never calls `useJsApiLoader` itself. Everything that refreshes on a
 * timer here (rider positions) is a REST call to OUR OWN backend, which reads
 * from Mongo and resolves zones from an in-process cache — not a single Maps
 * API request per refresh. Zone polygons are fetched once on mount, not on
 * every poll, since zone boundaries change rarely. Nothing on this page calls
 * Directions, Places, or Geocoding.
 */

const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 }; // India
const REFRESH_INTERVAL_MS = 20_000;

const containerStyle = { width: "100%", height: "100%" };

const mapOptions = {
  disableDefaultUI: true,
  zoomControl: true,
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: false,
  clickableIcons: false,
};

const formatTimeAgo = (value) => {
  if (!value) return "Never";
  const diffMs = Date.now() - new Date(value).getTime();
  if (diffMs < 0) return "Just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
};

/** A plain colored dot — no extra icon requests, unlike a custom PNG marker. */
const riderIcon = (color, isBusy) => ({
  path: "M0,0 m-8,0 a8,8 0 1,0 16,0 a8,8 0 1,0 -16,0",
  fillColor: color,
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWeight: isBusy ? 3 : 2,
  scale: 1,
});

const FleetZoneMap = () => {
  const { isLoaded, loadError } = useMapsLoader();

  const [zones, setZones] = useState([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [riders, setRiders] = useState([]);
  const [ridersLoading, setRidersLoading] = useState(true);
  const [syncedAt, setSyncedAt] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedRiderId, setSelectedRiderId] = useState(null);

  const mapRef = useRef(null);
  const hasFittedRef = useRef(false);

  // Zones change rarely (an admin drawing/editing one) — fetched once, not
  // re-polled alongside rider positions.
  const fetchZones = useCallback(async () => {
    setZonesLoading(true);
    try {
      const res = await adminPorterApi.getZones({ status: "active" });
      setZones(res?.data?.results || res?.data?.result?.items || []);
    } catch (err) {
      console.error(err);
      toast.error("Failed to load delivery zones");
    } finally {
      setZonesLoading(false);
    }
  }, []);

  const fetchRiders = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRidersLoading(true);
    try {
      const res = await adminDeliveryApi.getLiveFleetLocations();
      const data = res?.data?.result || {};
      setRiders(Array.isArray(data.items) ? data.items : []);
      setSyncedAt(data.syncedAt || new Date().toISOString());
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to load live rider locations");
    } finally {
      setRidersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchZones();
    fetchRiders(true);
  }, [fetchZones, fetchRiders]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => fetchRiders(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchRiders]);

  const handleMapLoad = useCallback((map) => {
    mapRef.current = map;
  }, []);

  // Frame every drawn zone once, so the operator lands on the covered area
  // instead of the whole-India default view. Runs once, not on every poll.
  useEffect(() => {
    if (hasFittedRef.current || !isLoaded || !mapRef.current || !window.google?.maps) return;
    if (!zones.length) return;
    const bounds = new window.google.maps.LatLngBounds();
    zones.forEach((zone) => (zone.points || []).forEach((p) => bounds.extend(p)));
    if (!bounds.isEmpty()) {
      mapRef.current.fitBounds(bounds, 64);
      hasFittedRef.current = true;
    }
  }, [isLoaded, zones]);

  const zonesById = useMemo(() => {
    const map = new Map();
    zones.forEach((z) => map.set(String(z._id), z));
    return map;
  }, [zones]);

  const grouped = useMemo(() => {
    const byZone = new Map();
    const unzoned = [];
    riders.forEach((r) => {
      if (!r.zone) {
        unzoned.push(r);
        return;
      }
      const key = r.zone.id;
      if (!byZone.has(key)) byZone.set(key, { zone: r.zone, riders: [] });
      byZone.get(key).riders.push(r);
    });
    return {
      zoneGroups: Array.from(byZone.values()).sort((a, b) => b.riders.length - a.riders.length),
      unzoned,
    };
  }, [riders]);

  const stats = useMemo(
    () => ({
      online: riders.length,
      inZone: riders.length - grouped.unzoned.length,
      unzoned: grouped.unzoned.length,
      zonesCovered: grouped.zoneGroups.length,
    }),
    [riders, grouped],
  );

  const selectedRider = riders.find((r) => r.id === selectedRiderId) || null;

  const focusRider = (rider) => {
    setSelectedRiderId(rider.id);
    if (mapRef.current) {
      mapRef.current.panTo({ lat: rider.lat, lng: rider.lng });
      if (mapRef.current.getZoom() < 14) mapRef.current.setZoom(14);
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <PageHeader
        title="Live Fleet Map"
        description="Where every online driver is right now, and which delivery zone they're in."
        badge={<Badge variant="info">Courier Ops</Badge>}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                autoRefresh
                  ? "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
              )}
              title={autoRefresh ? "Auto-refresh every 20s" : "Auto-refresh paused"}
            >
              {autoRefresh ? <Radio className="h-3.5 w-3.5 animate-pulse" /> : <Pause className="h-3.5 w-3.5" />}
              {autoRefresh ? "Live" : "Paused"}
            </button>
            <button
              type="button"
              onClick={() => fetchRiders(true)}
              disabled={ridersLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              <RotateCw className={cn("h-3.5 w-3.5", ridersLoading && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Stat cards */}
      <div className="ds-grid-cards-4">
        {[
          { label: "Online Riders", value: stats.online, icon: Users, color: "text-slate-700", bg: "bg-slate-100 border border-slate-200" },
          { label: "Inside a Zone", value: stats.inZone, icon: Layers, color: "text-orange-600", bg: "bg-orange-50 border border-orange-200" },
          { label: "Outside Any Zone", value: stats.unzoned, icon: MapPin, color: "text-amber-600", bg: "bg-amber-50 border border-amber-200" },
          { label: "Zones Covered", value: stats.zonesCovered, icon: Radio, color: "text-orange-600", bg: "bg-orange-50 border border-orange-200" },
        ].map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} color={s.color} bg={s.bg} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Map */}
        <Card className="overflow-hidden lg:col-span-2" contentClassName="p-0">
          <div className="relative" style={{ height: 560 }}>
            {!hasMapsKey() ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 bg-slate-50 text-center dark:bg-slate-900/60">
                <MapPin className="h-8 w-8 text-slate-400" />
                <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                  Google Maps key not configured
                </p>
                <p className="max-w-xs text-xs text-slate-400">
                  Set VITE_GOOGLE_MAPS_API_KEY to see riders on the map.
                </p>
              </div>
            ) : loadError ? (
              <div className="flex h-full items-center justify-center bg-red-50 text-sm font-semibold text-red-600">
                Failed to load Google Maps.
              </div>
            ) : !isLoaded ? (
              <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-900">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : (
              <GoogleMap
                mapContainerStyle={containerStyle}
                center={DEFAULT_CENTER}
                zoom={5}
                onLoad={handleMapLoad}
                options={mapOptions}
              >
                {zones.map((zone) => (
                  <Polygon
                    key={zone._id}
                    path={zone.points || []}
                    options={{
                      fillColor: zone.color || "#2563EB",
                      fillOpacity: 0.1,
                      strokeColor: zone.color || "#2563EB",
                      strokeOpacity: 0.7,
                      strokeWeight: 1.5,
                      clickable: false,
                      zIndex: 1,
                    }}
                  />
                ))}

                {riders.map((rider) => (
                  <Marker
                    key={rider.id}
                    position={{ lat: rider.lat, lng: rider.lng }}
                    icon={riderIcon(rider.zone?.color || "#64748B", rider.isBusy)}
                    onClick={() => setSelectedRiderId(rider.id)}
                    zIndex={2}
                  />
                ))}

                {selectedRider && (
                  <InfoWindow
                    position={{ lat: selectedRider.lat, lng: selectedRider.lng }}
                    onCloseClick={() => setSelectedRiderId(null)}
                  >
                    <div className="min-w-[160px] text-xs">
                      <p className="text-sm font-bold text-slate-900">{selectedRider.name}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-slate-500">
                        <Phone className="h-3 w-3" /> {selectedRider.phone}
                      </p>
                      <p className="mt-1 font-semibold" style={{ color: selectedRider.zone?.color || "#64748B" }}>
                        {selectedRider.zone?.name || "Outside any zone"}
                      </p>
                      <p className="mt-1 flex items-center gap-1 text-slate-400">
                        <Clock className="h-3 w-3" /> {formatTimeAgo(selectedRider.lastLocationAt)}
                      </p>
                    </div>
                  </InfoWindow>
                )}
              </GoogleMap>
            )}

            {(zonesLoading || ridersLoading) && isLoaded && hasMapsKey() && (
              <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 shadow-sm backdrop-blur-sm dark:bg-slate-900/90 dark:text-slate-300">
                <Loader2 className="h-3 w-3 animate-spin" /> Syncing...
              </div>
            )}
          </div>
        </Card>

        {/* Rider list, grouped by zone */}
        <Card
          className="overflow-hidden lg:col-span-1"
          contentClassName="p-0"
          title="Drivers by Zone"
          subtitle={syncedAt ? `Synced ${formatTimeAgo(syncedAt)}` : "Waiting for first sync"}
        >
          <div className="max-h-[560px] overflow-y-auto p-3">
            {!ridersLoading && riders.length === 0 ? (
              <EmptyState icon={Users} title="No riders online" description="No riders are online right now." />
            ) : (
              <div className="space-y-4">
                {grouped.zoneGroups.map(({ zone, riders: zoneRiders }) => (
                  <div key={zone.id}>
                    <div className="mb-1.5 flex items-center gap-2 px-1">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: zone.color || "#2563EB" }}
                      />
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                        {zone.name}
                      </p>
                      <span className="ml-auto text-[11px] font-semibold text-slate-400">
                        {zoneRiders.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {zoneRiders.map((rider) => (
                        <RiderRow
                          key={rider.id}
                          rider={rider}
                          active={rider.id === selectedRiderId}
                          onClick={() => focusRider(rider)}
                        />
                      ))}
                    </div>
                  </div>
                ))}

                {grouped.unzoned.length > 0 && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-2 px-1">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-400" />
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                        Outside Any Zone
                      </p>
                      <span className="ml-auto text-[11px] font-semibold text-slate-400">
                        {grouped.unzoned.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {grouped.unzoned.map((rider) => (
                        <RiderRow
                          key={rider.id}
                          rider={rider}
                          active={rider.id === selectedRiderId}
                          onClick={() => focusRider(rider)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

const RiderRow = ({ rider, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
      active ? "bg-primary/10" : "hover:bg-slate-50 dark:hover:opacity-90/60",
    )}
  >
    <span
      className={cn(
        "relative h-2 w-2 shrink-0 rounded-full",
        rider.isBusy ? "bg-amber-500" : "bg-orange-500",
      )}
    />
    <div className="min-w-0 flex-1">
      <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">{rider.name}</p>
      <p className="text-[11px] text-slate-400">
        {rider.isBusy ? "On a delivery" : "Available"} · {formatTimeAgo(rider.lastLocationAt)}
      </p>
    </div>
  </button>
);

export default FleetZoneMap;
