import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GoogleMap, Marker, OverlayView } from "@react-google-maps/api";
import { MapPin, CheckCircle2, QrCode, Phone, Package } from "lucide-react";
import { toast } from "sonner";
import { parcelApi } from "../../customer/services/parcelApi";
import { invalidateCache } from "@core/api/dedupe";
import ParcelProofCapture from "../components/ParcelProofCapture";
import CodOnlineQrSheet from "../components/CodOnlineQrSheet";
import {
  getCachedDeliveryPartnerLocation,
  getCurrentPositionWithCache,
  saveDeliveryPartnerLocation,
} from "../utils/deliveryLastLocation";
import { useMapsLoader } from "@core/maps/useMapsLoader";

const NEXT_STATUS = {
  ACCEPTED: { next: "RIDER_ASSIGNED", label: "Start Ride to Customer" },
  RIDER_ASSIGNED: { next: "PICKUP_REACHED", label: "Reached Customer" },
  // PICKUP_REACHED → PICKED_UP only after customer OTP verification (handled separately).
  // After PICKED_UP the rider goes straight to the courier drop-off + proof
  // (no more intermediate OUT_FOR_DELIVERY status/step).
};
const TO_CUSTOMER_STATUSES = new Set(["ACCEPTED", "RIDER_ASSIGNED", "PICKUP_REACHED"]);

const ROUTE_REFRESH_MS = 20000;
/** Bottom sheet snap heights (vh). Drag handle up/down to switch. */
const SHEET_SNAPS = [34, 58, 88];
const DEFAULT_SHEET_VH = 58;

function nearestSheetSnap(vh) {
  return SHEET_SNAPS.reduce((best, snap) =>
    Math.abs(snap - vh) < Math.abs(best - vh) ? snap : best,
  );
}

function toLatLng(point) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function formatDistanceKm(meters) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m < 0) return null;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
}

const ParcelTaskPage = () => {
  const navigate = useNavigate();
  const { parcelId } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [otp, setOtp] = useState("");
  const [pickupProofUrl, setPickupProofUrl] = useState("");
  const [parcel, setParcel] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);
  const [riderLocation, setRiderLocation] = useState(() => {
    const cached = getCachedDeliveryPartnerLocation(30 * 60 * 1000);
    return cached ? { lat: cached.lat, lng: cached.lng } : null;
  });
  const [sheetVh, setSheetVh] = useState(DEFAULT_SHEET_VH);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  // Customer at the door asking to pay by UPI instead of cash.
  const [codQrOpen, setCodQrOpen] = useState(false);
  const mapRef = useRef(null);
  const routePolylineRef = useRef(null);
  const assignedRequestRef = useRef({ inFlight: false, lastFetchedAt: 0 });
  const lastRouteKeyRef = useRef("");
  const lastRouteAtRef = useRef(0);
  const routeAbortRef = useRef(null);
  const sheetDragRef = useRef({
    active: false,
    pointerId: null,
    startY: 0,
    startVh: DEFAULT_SHEET_VH,
  });

  const onSheetHandlePointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    sheetDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startY: e.clientY,
      startVh: sheetVh,
    };
    setIsSheetDragging(true);
  }, [sheetVh]);

  const onSheetHandlePointerMove = useCallback((e) => {
    const drag = sheetDragRef.current;
    if (!drag.active || drag.pointerId !== e.pointerId) return;
    const deltaY = drag.startY - e.clientY; // up = expand
    const next = Math.min(
      SHEET_SNAPS[SHEET_SNAPS.length - 1],
      Math.max(SHEET_SNAPS[0], drag.startVh + (deltaY / window.innerHeight) * 100),
    );
    setSheetVh(next);
  }, []);

  const endSheetDrag = useCallback((e) => {
    const drag = sheetDragRef.current;
    if (!drag.active || (e?.pointerId != null && drag.pointerId !== e.pointerId)) return;
    sheetDragRef.current.active = false;
    setIsSheetDragging(false);
    setSheetVh((prev) => nearestSheetSnap(prev));
  }, []);

  const toggleSheetSnap = useCallback(() => {
    setSheetVh((prev) => {
      const idx = SHEET_SNAPS.findIndex((s) => s === nearestSheetSnap(prev));
      return SHEET_SNAPS[(idx + 1) % SHEET_SNAPS.length];
    });
  }, []);

  const { isLoaded, loadError } = useMapsLoader();

  const loadAssignedParcel = useCallback(async (silent = false, options = {}) => {
    const force = options.force === true;
    if (!parcelId) return;
    const now = Date.now();
    if (!force && silent && now - assignedRequestRef.current.lastFetchedAt < 45000) return;
    if (assignedRequestRef.current.inFlight) return;
    if (!silent) setLoading(true);
    assignedRequestRef.current.inFlight = true;
    try {
      const res = await parcelApi.riderGetAssigned({
        ttl: 30000,
        forceRefresh: force,
      });
      if (!res.data?.success) throw new Error("Failed to load assigned couriers");
      const list = res.data.results || res.data.result || [];
      const match = list.find((p) => String(p._id) === String(parcelId));
      if (!match) {
        if (!silent) toast.error("Courier task not found or no longer assigned.");
        navigate("/delivery/dashboard");
        return;
      }
      setParcel(match);
    } catch (error) {
      if (!silent) toast.error("Failed to load courier task");
      navigate("/delivery/dashboard");
    } finally {
      assignedRequestRef.current.inFlight = false;
      assignedRequestRef.current.lastFetchedAt = Date.now();
      if (!silent) setLoading(false);
    }
  }, [parcelId, navigate]);

  useEffect(() => {
    loadAssignedParcel(false, { force: true });
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      loadAssignedParcel(true);
    }, 45000);
    return () => clearInterval(timer);
  }, [loadAssignedParcel]);

  // Live GPS so map can route rider → customer pickup.
  useEffect(() => {
    getCurrentPositionWithCache(
      ({ lat, lng }) => setRiderLocation({ lat, lng }),
      undefined,
      { maxCacheAgeMs: 30 * 60 * 1000 },
    );

    if (typeof navigator === "undefined" || !navigator.geolocation) return undefined;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        saveDeliveryPartnerLocation(lat, lng);
        setRiderLocation({ lat, lng });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 8000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const statusStep = useMemo(() => NEXT_STATUS[parcel?.status], [parcel?.status]);
  const completed = parcel?.status === "DELIVERED";
  const cancelled = parcel?.status === "CANCELLED";
  const goingToCustomer = TO_CUSTOMER_STATUSES.has(parcel?.status);

  const pickupPoint = useMemo(
    () => toLatLng(parcel?.pickupAddress),
    [parcel?.pickupAddress?.lat, parcel?.pickupAddress?.lng],
  );
  // Drop destination is always the customer-selected courier company now —
  // it has no pinned location (just name + phone), so there is no
  // route/map for this leg, only "go there yourself, upload photo when done".
  const courierName = parcel?.courierCompanyId?.name || "";
  const courierPhone = parcel?.courierCompanyId?.phone || "";
  const courierCity = parcel?.destinationCity || "";
  const customerName =
    parcel?.pickupAddress?.name || parcel?.customerId?.name || "Customer";
  const customerPhone = parcel?.pickupAddress?.phone || parcel?.customerId?.phone || "";

  const isParcelCod = String(parcel?.paymentMethod).toUpperCase() === "COD";
  const codAmount = Number(parcel?.codSettlement?.collectAmount || parcel?.fare || 0);

  // Distance from where you accepted the job to the pickup point × the
  // admin's per-km rate — set once at accept time, so this number never
  // changes for the rest of the job.
  const earningBreakdown = parcel?.riderEarningBreakdown || null;

  /**
   * What the customer described at booking. The backend already sends all of
   * it (riderGetAssignedParcels only strips the OTP) — the rider screen just
   * never rendered any of it, so riders arrived not knowing what they were
   * picking up.
   */
  const packageLines = useMemo(() => {
    const pkg = parcel?.packageDetails || {};
    return [
      pkg.packageSegment,
      pkg.packageCategory || pkg.packageType,
      pkg.weight ? pkg.weight + " kg" : "",
    ].filter(Boolean);
  }, [parcel?.packageDetails]);

  // Primary job: go to customer and collect parcel. After pickup, the rider
  // drives to the courier company themselves — no pinned location for it,
  // so there is no second-leg route/map phase anymore.
  const routeEndpoints = useMemo(() => {
    if (!riderLocation) return null;
    if (goingToCustomer || !parcel?.status) {
      if (!pickupPoint) return null;
      return { origin: riderLocation, destination: pickupPoint, phase: "pickup" };
    }
    return null;
  }, [riderLocation, goingToCustomer, parcel?.status, pickupPoint]);

  const distanceLabel = useMemo(
    () => formatDistanceKm(routeData?.distanceMeters),
    [routeData?.distanceMeters],
  );

  const decodedPath = useMemo(() => {
    const encoded = routeData?.polyline;
    if (!encoded || !isLoaded || !window.google?.maps?.geometry?.encoding) return null;
    try {
      return window.google.maps.geometry.encoding.decodePath(encoded);
    } catch {
      return null;
    }
  }, [routeData?.polyline, isLoaded]);

  const linePath = useMemo(() => {
    if (decodedPath?.length) return decodedPath;
    if (!routeEndpoints?.origin || !routeEndpoints?.destination) return [];
    if (!routeData?.degraded) return [];
    return [
      routeEndpoints.origin,
      routeEndpoints.destination,
    ];
  }, [decodedPath, routeData?.degraded, routeEndpoints]);

  const fitRouteOnMap = useCallback((path) => {
    const map = mapRef.current;
    if (!map || !window.google) return;
    const bounds = new window.google.maps.LatLngBounds();
    (path || []).forEach((point) => bounds.extend(point));
    if (riderLocation) bounds.extend(riderLocation);
    if (pickupPoint) bounds.extend(pickupPoint);
    map.fitBounds(bounds, {
      top: 96,
      right: 36,
      bottom: Math.round(window.innerHeight * 0.42),
      left: 36,
    });
  }, [riderLocation, pickupPoint]);

  const fetchRoute = useCallback(async () => {
    if (!parcelId || !routeEndpoints) return;

    const { origin, destination, phase } = routeEndpoints;
    const routeKey = `${phase}:${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}>${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
    const now = Date.now();
    const timedOut = now - lastRouteAtRef.current >= ROUTE_REFRESH_MS;

    if (
      lastRouteKeyRef.current === routeKey ||
      (!timedOut && Boolean(lastRouteKeyRef.current))
    ) {
      return;
    }

    if (routeAbortRef.current) routeAbortRef.current.abort();
    const controller = new AbortController();
    routeAbortRef.current = controller;
    setRouteLoading(true);

    try {
      const res = await parcelApi.getParcelRoute(
        parcelId,
        {
          phase,
          originLat: origin.lat,
          originLng: origin.lng,
          _t: now,
        },
        { signal: controller.signal },
      );
      if (res.data?.success) {
        const nextRoute = res.data.result || res.data.data || null;
        lastRouteKeyRef.current = routeKey;
        lastRouteAtRef.current = Date.now();
        setRouteData(nextRoute);
      }
    } catch (error) {
      if (error?.name !== "CanceledError" && error?.code !== "ERR_CANCELED") {
        setRouteData((prev) => prev || { degraded: true });
      }
    } finally {
      if (routeAbortRef.current === controller) routeAbortRef.current = null;
      setRouteLoading(false);
    }
  }, [parcelId, routeEndpoints]);

  useEffect(() => {
    fetchRoute();
    const timer = setInterval(fetchRoute, ROUTE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      if (routeAbortRef.current) {
        routeAbortRef.current.abort();
        routeAbortRef.current = null;
      }
    };
  }, [fetchRoute]);

  useEffect(() => {
    if (!isLoaded || !mapInstance || !window.google?.maps) return undefined;

    if (routePolylineRef.current) {
      routePolylineRef.current.setMap(null);
      routePolylineRef.current = null;
    }

    if (!linePath?.length) return undefined;

    const pl = new window.google.maps.Polyline({
      path: linePath,
      strokeColor: "#2563eb",
      strokeOpacity: routeData?.degraded ? 0.55 : 0.95,
      strokeWeight: 6,
      map: mapInstance,
      zIndex: 10,
    });
    routePolylineRef.current = pl;
    requestAnimationFrame(() => fitRouteOnMap(linePath));

    return () => {
      if (routePolylineRef.current) {
        routePolylineRef.current.setMap(null);
        routePolylineRef.current = null;
      }
    };
  }, [isLoaded, mapInstance, linePath, routeData?.degraded, fitRouteOnMap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google) return undefined;
    const handleResize = () => {
      window.google.maps.event.trigger(map, "resize");
      if (linePath?.length) fitRouteOnMap(linePath);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [linePath, fitRouteOnMap]);

  const mapCenter = useMemo(() => {
    if (pickupPoint) return pickupPoint;
    if (riderLocation) return riderLocation;
    return { lat: 22.7196, lng: 75.8577 };
  }, [pickupPoint, riderLocation]);

  const handleAdvance = async () => {
    if (!parcel || !statusStep || saving) return;
    // Never skip OTP gate for customer pickup.
    if (statusStep.next === "PICKED_UP") return;
    setSaving(true);
    try {
      const res = await parcelApi.riderUpdateStatus({
        parcelId: parcel._id,
        status: statusStep.next,
      });
      if (res.data?.success) {
        const next = res.data.result || parcel;
        // Keep populated seller hub if status API returns only the ObjectId.
        const prevSeller = parcel.sellerId;
        const nextSeller = next.sellerId;
        const sellerLostPopulate =
          prevSeller &&
          typeof prevSeller === "object" &&
          prevSeller.location &&
          (!nextSeller ||
            typeof nextSeller !== "object" ||
            !nextSeller.location);
        setParcel(
          sellerLostPopulate ? { ...next, sellerId: prevSeller } : next,
        );
        // Force route rebuild for next phase.
        lastRouteKeyRef.current = "";
        lastRouteAtRef.current = 0;
        setRouteData(null);
        setOtp("");
        // The dashboard's "active task" card reads this same list through a
        // 30s module-level cache (getWithDedupe) — without this, returning
        // to the dashboard right after a status change could still show the
        // parcel at its previous status until that cache naturally expired.
        invalidateCache("/parcel/rider/assigned");
        toast.success("Courier status updated");
      } else {
        toast.error(res.data?.message || "Failed to update status");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to update status");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmPickupWithOtp = async () => {
    if (!parcel || saving) return;
    const code = String(otp || "").trim();
    if (code.length < 4) {
      toast.error("Enter the OTP shared by the customer");
      return;
    }
    if (!pickupProofUrl) {
      toast.error("Upload a photo proof at the customer location");
      return;
    }
    setSaving(true);
    try {
      const res = await parcelApi.riderUpdateStatus({
        parcelId: parcel._id,
        status: "PICKED_UP",
        otp: code,
        pickupProofImage: pickupProofUrl,
      });
      if (res.data?.success) {
        setOtp("");
        setPickupProofUrl("");
        // Same cache-invalidation reason as handleAdvance above — this is
        // the call that actually completes the parcel (pickup === delivery
        // now), so the dashboard's active-task card must not still find it
        // through a stale cached list.
        invalidateCache("/parcel/rider/assigned");
        toast.success("Pickup confirmed — courier delivered");
        navigate("/delivery/dashboard");
      } else {
        toast.error(res.data?.message || "Invalid OTP");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Invalid pickup OTP");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !parcel) {
    return <div className="p-6 text-sm font-semibold text-slate-500">Loading courier task...</div>;
  }

  return (
    <div className="h-screen bg-slate-100 relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        {loadError ? (
          <div className="h-full w-full flex items-center justify-center px-6 text-center text-sm text-rose-700 bg-rose-50">
            Map failed to load. Check your Google Maps API key.
          </div>
        ) : isLoaded ? (
          <GoogleMap
            mapContainerStyle={{ width: "100%", height: "100%" }}
            center={mapCenter}
            zoom={13}
            onLoad={(map) => {
              mapRef.current = map;
              setMapInstance(map);
              if (linePath?.length) fitRouteOnMap(linePath);
            }}
            options={{
              disableDefaultUI: true,
              zoomControl: true,
              streetViewControl: false,
              mapTypeControl: false,
              gestureHandling: "greedy",
            }}
          >
            {riderLocation && (
              <Marker
                position={riderLocation}
                title="You"
                icon={{
                  path: window.google.maps.SymbolPath.CIRCLE,
                  scale: 9,
                  fillColor: "#2563eb",
                  fillOpacity: 1,
                  strokeColor: "#ffffff",
                  strokeWeight: 3,
                }}
              />
            )}
            {pickupPoint && (
              <>
                <Marker
                  position={pickupPoint}
                  title={`Customer: ${customerName}`}
                  label={{ text: "U", color: "white", fontWeight: "700" }}
                />
                {goingToCustomer && (
                  <OverlayView
                    position={pickupPoint}
                    mapPaneName={OverlayView.FLOAT_PANE}
                    getPixelPositionOffset={(width, height) => ({
                      x: -(width / 2),
                      y: -(height + 42),
                    })}
                  >
                    <div className="rounded-lg bg-white px-2.5 py-1 shadow-md border border-slate-200 text-[10px] font-black text-slate-800 whitespace-nowrap max-w-[180px] truncate">
                      {customerName}
                    </div>
                  </OverlayView>
                )}
              </>
            )}
            {distanceLabel && routeEndpoints?.origin && routeEndpoints?.destination && (
              <OverlayView
                position={{
                  lat: (routeEndpoints.origin.lat + routeEndpoints.destination.lat) / 2,
                  lng: (routeEndpoints.origin.lng + routeEndpoints.destination.lng) / 2,
                }}
                mapPaneName={OverlayView.FLOAT_PANE}
                getPixelPositionOffset={(width, height) => ({
                  x: -(width / 2),
                  y: -(height / 2),
                })}
              >
                <div className="rounded-full bg-blue-600 text-white px-3 py-1 shadow-lg text-[11px] font-black whitespace-nowrap">
                  {distanceLabel}
                </div>
              </OverlayView>
            )}
          </GoogleMap>
        ) : (
          <div className="h-full w-full bg-slate-100 animate-pulse" />
        )}
      </div>

      {routeData?.degraded && (
        <div className="absolute top-24 left-4 right-4 z-20 rounded-xl bg-amber-50/95 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 leading-snug">
          Road route unavailable. Add <span className="font-mono">GOOGLE_MAPS_API_KEY</span> to backend
          .env with Directions API enabled, then restart the server.
        </div>
      )}

      {routeLoading && !linePath?.length && (
        <div className="absolute top-24 left-4 z-20 rounded-lg bg-white/95 px-3 py-1.5 text-[11px] font-semibold text-slate-600 shadow">
          Loading route...
        </div>
      )}

      <div className="absolute top-4 left-4 right-4 z-20 rounded-2xl bg-white/90 backdrop-blur-md px-4 py-3 shadow">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Courier Task</p>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-700">
            📦 Drop at Courier
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 mt-1">
          <p className="text-sm font-black text-slate-900">ID: #{String(parcel._id).slice(-6)}</p>
          <div className="flex items-center gap-1.5">
            {parcel.deliverySpeed === "express" ? (
              <span className="inline-flex px-2.5 py-1 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 uppercase">
                Express
              </span>
            ) : (
              <span className="inline-flex px-2.5 py-1 rounded-full text-[10px] font-black bg-slate-100 text-slate-600 uppercase">
                Normal
              </span>
            )}
            <div className="inline-flex px-3 py-1 rounded-full text-[10px] font-black bg-blue-100 text-blue-700">
              {parcel.status}
            </div>
          </div>
        </div>
        <p className="text-[11px] font-semibold text-slate-500 mt-1">
          {goingToCustomer
            ? `Go to customer · collect courier${distanceLabel ? ` · ${distanceLabel}` : ""}`
            : `Drop at ${courierName || "courier company"}`}
          {parcel.deliverySpeed === "express" ? " · 10 min" : " · 30 min"}
        </p>
        {earningBreakdown && earningBreakdown.earning > 0 && (
          <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">
              Your Earning
            </p>
            <p className="text-lg font-black text-emerald-900">
              ₹{earningBreakdown.earning.toFixed(2)}
            </p>
            <p className="text-[10px] font-semibold text-emerald-700/80">
              {earningBreakdown.distanceKm} km (accept point → pickup) × ₹
              {earningBreakdown.ratePerKm}/km
            </p>
          </div>
        )}
        {isParcelCod && (
          <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
              Collect COD from customer
            </p>
            <p className="text-lg font-black text-amber-900">
              ₹{codAmount.toFixed(2)}
            </p>
            <p className="text-[10px] font-semibold text-amber-700/80">
              Collect at customer pickup, then deposit the cash from Profile → Courier Cash Deposit
            </p>
            {goingToCustomer && (
              <button
                type="button"
                onClick={() => setCodQrOpen(true)}
                className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 py-2 text-[11px] font-black text-white"
              >
                <QrCode className="h-3.5 w-3.5" />
                Customer wants to pay online
              </button>
            )}
          </div>
        )}
        {parcel.paymentStatus === "PAID" &&
          String(parcel.paymentMethod).toUpperCase() !== "COD" && (
            <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">
                Already paid online
              </p>
              <p className="text-[10px] font-semibold text-emerald-700/80">
                Do not collect any cash from the customer.
              </p>
            </div>
          )}
        {(courierName || courierCity) && (
          <p className="text-[10px] text-slate-400 mt-0.5">
            Courier: {courierName || "—"}
            {courierCity ? ` · ${courierCity}` : ""}
          </p>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 pointer-events-none">
        <div
          className="pointer-events-auto bg-white rounded-t-[24px] shadow-[0_-20px_50px_rgba(15,23,42,0.16)] flex flex-col min-h-0 will-change-[height]"
          style={{
            height: `${sheetVh}vh`,
            maxHeight: "92vh",
            transition: isSheetDragging ? "none" : "height 220ms ease-out",
          }}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label="Drag sheet up or down"
            onPointerDown={onSheetHandlePointerDown}
            onPointerMove={onSheetHandlePointerMove}
            onPointerUp={endSheetDrag}
            onPointerCancel={endSheetDrag}
            onDoubleClick={toggleSheetSnap}
            className="shrink-0 touch-none select-none cursor-grab active:cursor-grabbing pt-2.5 pb-2 px-4"
          >
            <div className="mx-auto h-1.5 w-12 rounded-full bg-slate-300" />
            <p className="mt-1.5 text-center text-[10px] font-bold text-slate-400 tracking-wide">
              Swipe up / down
            </p>
          </div>

          <div
            data-lenis-prevent
            data-lenis-prevent-touch
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-5 pb-6 space-y-3"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-2.5 py-2 space-y-1.5">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 mt-0.5 text-brand-600" />
              <div>
                <p className="text-[11px] font-black text-slate-700">
                  Customer location {goingToCustomer ? "(go here)" : ""}
                </p>
                <p className="text-xs font-semibold text-slate-800">{customerName}</p>
                {customerPhone ? (
                  <a
                    href={`tel:${customerPhone}`}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1 text-[11px] font-black text-brand-700"
                  >
                    <Phone className="h-3 w-3" />
                    {customerPhone}
                  </a>
                ) : null}
                <p className="text-xs text-slate-500 mt-0.5">{parcel.pickupAddress?.fullAddress}</p>
                {goingToCustomer && distanceLabel ? (
                  <p className="text-[11px] font-bold text-blue-600 mt-0.5">
                    Distance: {distanceLabel}
                  </p>
                ) : null}
              </div>
            </div>
            {!goingToCustomer && (
              <div className="flex items-start gap-2 pt-1 border-t border-slate-200/80">
                <MapPin className="h-4 w-4 mt-0.5 text-primary" />
                <div>
                  <p className="text-[11px] font-black text-slate-700">Drop at courier company</p>
                  <p className="text-xs font-semibold text-slate-800">
                    {courierName || "Courier company"}
                  </p>
                  {courierPhone ? (
                    <a
                      href={`tel:${courierPhone}`}
                      className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1 text-[11px] font-black text-brand-700"
                    >
                      <Phone className="h-3 w-3" />
                      {courierPhone}
                    </a>
                  ) : null}
                  {courierCity ? (
                    <p className="text-[11px] text-slate-500 mt-0.5">{courierCity}</p>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {(packageLines.length > 0 || parcel.packageDetails?.description) && (
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-2.5 py-2">
              <div className="flex items-start gap-2">
                <Package className="h-4 w-4 mt-0.5 text-slate-500" />
                <div>
                  <p className="text-[11px] font-black text-slate-700">What you are picking up</p>
                  {packageLines.length > 0 && (
                    <p className="text-xs font-semibold text-slate-800">
                      {packageLines.join(" · ")}
                    </p>
                  )}
                  {parcel.packageDetails?.description ? (
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {parcel.packageDetails.description}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {!pickupPoint && (
            <div className="rounded-xl border border-amber-100 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-900">
              Customer location is missing for this courier, so the map cannot navigate to the user.
            </div>
          )}
          {goingToCustomer && pickupPoint && !riderLocation && (
            <div className="rounded-xl border border-amber-100 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-900">
              Waiting for your GPS… Enable location so the route to the customer can load.
            </div>
          )}
          {parcel.status === "PICKUP_REACHED" && !completed && !cancelled && (
            <div className="rounded-xl border border-orange-200 bg-orange-50/80 px-3 py-2.5 space-y-3">
              <p className="text-xs font-bold text-slate-800">
                Ask customer for pickup OTP
              </p>
              <p className="text-[11px] text-slate-600 leading-snug">
                First capture a photo at the customer location, then enter the OTP shown on the customer app.
              </p>
              <ParcelProofCapture
                label="Pickup photo proof"
                hint="Photo of courier with customer / at pickup point"
                value={pickupProofUrl}
                onChange={setPickupProofUrl}
                disabled={saving}
              />
              <input
                type="text"
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 4))}
                maxLength={4}
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white tracking-[0.2em] font-black"
                placeholder="4-digit OTP"
              />
              <button
                type="button"
                onClick={handleConfirmPickupWithOtp}
                disabled={saving || otp.trim().length < 4 || !pickupProofUrl}
                className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-black flex items-center justify-center gap-2 disabled:opacity-70"
              >
                <CheckCircle2 size={16} />
                {saving ? "Verifying..." : "Confirm Pickup with OTP"}
              </button>
            </div>
          )}

          {!completed &&
            !cancelled &&
            statusStep &&
            parcel.status !== "PICKUP_REACHED" && (
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={handleAdvance}
                disabled={saving}
                className="w-full py-2 rounded-xl bg-primary text-white text-[13px] font-black disabled:opacity-70"
              >
                {saving ? "Updating..." : statusStep.label}
              </button>
            </div>
          )}

          {(completed || cancelled) && (
            <button
              type="button"
              onClick={() => navigate("/delivery/dashboard")}
              className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-black"
            >
              Back to Dashboard
            </button>
          )}
          </div>
        </div>
      </div>
      <CodOnlineQrSheet
        open={codQrOpen}
        kind="parcel"
        bookingId={parcelId}
        amount={codAmount}
        onClose={() => setCodQrOpen(false)}
        onPaid={() => loadAssignedParcel(true, { force: true })}
      />
    </div>

  );
};

export default ParcelTaskPage;
