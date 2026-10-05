import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GoogleMap, Marker, DirectionsRenderer } from "@react-google-maps/api";
import { X, ShieldCheck, Zap, User, Phone, Package } from "lucide-react";
import { toast } from "sonner";
import { parcelApi } from "../services/parcelApi";
import { getOrderSocket, onParcelStatusUpdate } from "@/core/services/orderSocket";
import { createSocketTokenReader } from "@core/utils/authStorage";
import { STORAGE_KEYS } from "@core/utils/storage";
import ParcelReviewPrompt from "../components/parcel/ParcelReviewPrompt";
import { useMapsLoader } from "@core/maps/useMapsLoader";

const getCustomerToken = createSocketTokenReader(STORAGE_KEYS.AUTH_CUSTOMER);
const SEARCH_STATUSES = new Set(["REQUESTED", "SEARCHING"]);
const TERMINAL_STATUSES = new Set(["DELIVERED", "CANCELLED"]);
/** After captain collects from user, customer live tracking ends. */
const POST_PICKUP_STATUSES = new Set(["PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"]);

const sliderTexts = [
  "Booking created. Notifying nearby captains...",
  "Nearest riders are getting this request now...",
  "First rider to accept will be assigned to you.",
  "Broadcasted to nearby captains...",
];

function coordsToLatLng(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function addressToLatLng(address) {
  if (!address) return null;
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function distanceMeters(from, to) {
  if (!from || !to) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistanceAway(meters) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${(meters / 1000).toFixed(1)} km away`;
}

function getStatusUi(status) {
  switch (status) {
    case "ACCEPTED":
    case "RIDER_ASSIGNED":
      return {
        title: "Captain assigned",
        subtitle: "Your delivery captain is on the way to pickup.",
      };
    case "PICKUP_REACHED":
      return {
        title: "Captain at pickup",
        subtitle: "Rider has reached the pickup point.",
      };
    case "PICKED_UP":
      return {
        title: "Courier collected",
        subtitle: "Captain collected your courier. Live tracking has ended.",
      };
    case "OUT_FOR_DELIVERY":
      return {
        title: "Courier collected",
        subtitle: "Your courier is with the captain. Live tracking has ended.",
      };
    case "DELIVERED":
      return {
        title: "Completed",
        subtitle: "Your courier request is complete.",
      };
    case "CANCELLED":
      return {
        title: "Cancelled",
        subtitle: "This courier request was cancelled.",
      };
    default:
      return {
        title: "Finding your delivery captain",
        subtitle: null,
      };
  }
}

function formatStatusLabel(status) {
  return String(status || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Bottom sheet snap heights (vh). Drag handle up/down to switch. */
const SHEET_SNAPS = [36, 58, 88];
const DEFAULT_SHEET_VH = 58;

function nearestSheetSnap(vh) {
  return SHEET_SNAPS.reduce((best, snap) =>
    Math.abs(snap - vh) < Math.abs(best - vh) ? snap : best,
  );
}

const ParcelSearchTrackingPage = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const mapRef = useRef(null);
  const [parcel, setParcel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [requestingLateRefund, setRequestingLateRefund] = useState(false);
  const [sliderIndex, setSliderIndex] = useState(0);
  const [directions, setDirections] = useState(null);
  const [routeDistanceM, setRouteDistanceM] = useState(null);
  const [sheetVh, setSheetVh] = useState(DEFAULT_SHEET_VH);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
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
    const deltaY = drag.startY - e.clientY;
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

  const { isLoaded } = useMapsLoader();

  const loadParcel = useCallback(async (silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
    try {
      const response = await parcelApi.trackParcel(id);
      if (response.data?.success) {
        setParcel(response.data.result);
      } else if (!silent) {
        toast.error("Could not load courier details");
      }
    } catch {
      if (!silent) toast.error("Failed to load courier");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadParcel(false);
  }, [loadParcel]);

  useEffect(() => {
    if (!SEARCH_STATUSES.has(parcel?.status)) return undefined;
    const timer = setInterval(() => {
      setSliderIndex((prev) => (prev + 1) % sliderTexts.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [parcel?.status]);

  const riderPartnerId =
    parcel?.deliveryPartnerId && typeof parcel.deliveryPartnerId === "object"
      ? String(parcel.deliveryPartnerId._id || "")
      : parcel?.deliveryPartnerId
        ? String(parcel.deliveryPartnerId)
        : "";

  useEffect(() => {
    // Live tracking only until captain collects from user.
    if (
      !parcel?._id ||
      TERMINAL_STATUSES.has(parcel.status) ||
      POST_PICKUP_STATUSES.has(parcel.status)
    ) {
      return undefined;
    }
    // Stable deps only — populated deliveryPartner object must NOT restart the interval.
    const pollMs = SEARCH_STATUSES.has(parcel.status) ? 8000 : riderPartnerId ? 10000 : 12000;
    const timer = setInterval(() => loadParcel(true), pollMs);
    return () => clearInterval(timer);
  }, [parcel?._id, parcel?.status, riderPartnerId, loadParcel]);

  useEffect(() => {
    if (!id) return undefined;
    const getToken = getCustomerToken;
    getOrderSocket(getToken);
    return onParcelStatusUpdate(getToken, (payload) => {
      const payloadId = payload?.parcelId || payload?.parcel?._id;
      if (!payloadId || String(payloadId) !== String(id)) return;
      // Always refresh so pickupSla / lateRefundRequest stay accurate.
      loadParcel(true);
    });
  }, [id, loadParcel]);

  const pickupPoint = useMemo(
    () => addressToLatLng(parcel?.pickupAddress),
    [parcel?.pickupAddress?.lat, parcel?.pickupAddress?.lng],
  );

  const rider = parcel?.deliveryPartnerId;
  const riderPoint = useMemo(
    () => (typeof rider === "object" ? coordsToLatLng(rider?.location?.coordinates) : null),
    [rider?.location?.coordinates?.[0], rider?.location?.coordinates?.[1]],
  );

  const trackingActive = Boolean(
    parcel &&
      !POST_PICKUP_STATUSES.has(parcel.status) &&
      !TERMINAL_STATUSES.has(parcel.status),
  );

  const routeEndpoints = useMemo(() => {
    if (!trackingActive || !pickupPoint || !riderPoint) return null;
    return { origin: riderPoint, destination: pickupPoint, phase: "pickup" };
  }, [trackingActive, riderPoint, pickupPoint]);

  useEffect(() => {
    if (!isLoaded || !window.google || !routeEndpoints) {
      setDirections(null);
      setRouteDistanceM(null);
      return;
    }

    const { origin, destination } = routeEndpoints;
    const service = new window.google.maps.DirectionsService();
    let cancelled = false;

    service.route(
      {
        origin,
        destination,
        travelMode: window.google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (cancelled) return;
        if (status === window.google.maps.DirectionsStatus.OK) {
          setDirections(result);
          const legMeters = result?.routes?.[0]?.legs?.[0]?.distance?.value;
          setRouteDistanceM(Number.isFinite(legMeters) ? legMeters : distanceMeters(origin, destination));
        } else {
          setDirections(null);
          setRouteDistanceM(distanceMeters(origin, destination));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    isLoaded,
    routeEndpoints?.origin?.lat,
    routeEndpoints?.origin?.lng,
    routeEndpoints?.destination?.lat,
    routeEndpoints?.destination?.lng,
    routeEndpoints?.phase,
  ]);

  const fitMapToPoints = useCallback((map, points) => {
    if (!map || !window.google || !points?.length) return;
    if (points.length === 1) {
      map.setCenter(points[0]);
      map.setZoom(15);
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, {
      top: 110,
      right: 40,
      bottom: Math.round(window.innerHeight * 0.48),
      left: 40,
    });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = trackingActive
      ? [pickupPoint, riderPoint].filter(Boolean)
      : pickupPoint
        ? [pickupPoint]
        : [];
    const unique = [];
    points.forEach((p) => {
      if (!unique.some((u) => Math.abs(u.lat - p.lat) < 1e-6 && Math.abs(u.lng - p.lng) < 1e-6)) {
        unique.push(p);
      }
    });
    fitMapToPoints(map, unique);
  }, [
    trackingActive,
    pickupPoint?.lat,
    pickupPoint?.lng,
    riderPoint?.lat,
    riderPoint?.lng,
    fitMapToPoints,
  ]);

  const mapCenter = pickupPoint || { lat: 22.7196, lng: 75.8577 };

  const isSearching =
    SEARCH_STATUSES.has(parcel?.status) && !parcel?.deliveryPartnerId;
  const statusUi = getStatusUi(parcel?.status);
  const riderName = typeof rider === "object" ? rider?.name : null;
  const riderPhone = typeof rider === "object" ? rider?.phone : null;

  const captainAwayText = useMemo(() => {
    if (!trackingActive || !riderPoint || !pickupPoint) return null;
    const meters = routeDistanceM ?? distanceMeters(riderPoint, pickupPoint);
    return formatDistanceAway(meters);
  }, [trackingActive, riderPoint, pickupPoint, routeDistanceM]);

  const handleCancelSearch = async () => {
    if (!parcel?._id || !isSearching || cancelling) return;
    setCancelling(true);
    try {
      const response = await parcelApi.cancelSearch(parcel._id);
      if (response.data?.success) {
        const refund = response.data.result?.refund;
        if (refund?.attempted && refund.ok) {
          toast.success(
            refund.status === "REFUNDED"
              ? `Cancelled — ₹${refund.amountRupees} refunded to your original payment method.`
              : "Cancelled — your refund is being processed.",
          );
        } else if (refund?.attempted && !refund.ok) {
          toast.success(
            "Cancelled. We're having trouble refunding automatically — our team will process it shortly.",
          );
        } else {
          toast.success("Search cancelled");
        }
        setParcel(response.data.result);
        navigate("/parcel");
      } else {
        toast.error(response.data?.message || "Unable to cancel search");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to cancel search");
    } finally {
      setCancelling(false);
    }
  };

  const handleRequestLateRefund = async () => {
    if (!parcel?._id || requestingLateRefund) return;
    setRequestingLateRefund(true);
    try {
      const response = await parcelApi.requestLateRefund(parcel._id, {
        reason: "Normal pickup exceeded 30 minutes",
      });
      if (response.data?.success) {
        toast.success("Late refund request sent to admin");
        setParcel(response.data.result);
        loadParcel(true);
      } else {
        toast.error(response.data?.message || "Unable to request refund");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to request refund");
    } finally {
      setRequestingLateRefund(false);
    }
  };

  if (loading || !parcel) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <div className="text-sm font-semibold text-slate-500">Loading tracking...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-100 -mx-4 md:mx-0 relative font-outfit overflow-hidden">
      <div className="absolute inset-0 z-0">
        {isLoaded ? (
          <GoogleMap
            mapContainerStyle={{ width: "100%", height: "100%" }}
            center={mapCenter}
            zoom={15}
            onLoad={(map) => {
              mapRef.current = map;
              const points = [pickupPoint, riderPoint].filter(Boolean);
              fitMapToPoints(map, points.length ? points : pickupPoint ? [pickupPoint] : []);
            }}
            options={{
              disableDefaultUI: true,
              zoomControl: true,
              streetViewControl: false,
              mapTypeControl: false,
            }}
          >
            {directions && trackingActive && (
              <DirectionsRenderer
                directions={directions}
                options={{
                  suppressMarkers: true,
                  polylineOptions: {
                    strokeColor: "#2563eb",
                    strokeOpacity: 0.95,
                    strokeWeight: 6,
                  },
                }}
              />
            )}

            {pickupPoint && (
              <Marker
                position={pickupPoint}
                label={{ text: "You", color: "white", fontWeight: "bold", fontSize: "11px" }}
                title="Your pickup location"
              />
            )}

            {trackingActive && riderPoint && (
              <Marker
                position={riderPoint}
                icon={{
                  path: window.google.maps.SymbolPath.CIRCLE,
                  scale: 10,
                  fillColor: "#ea580c",
                  fillOpacity: 1,
                  strokeColor: "#ffffff",
                  strokeWeight: 3,
                }}
                title={riderName ? `Captain: ${riderName}` : "Delivery captain"}
              />
            )}
          </GoogleMap>
        ) : (
          <div className="h-full w-full bg-slate-200 animate-pulse" />
        )}
      </div>

      {isSearching && (
        <div className="absolute top-[24%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 h-28 w-28 pointer-events-none">
          <div className="absolute inset-0 rounded-full bg-orange-700/18 animate-ping" />
          <div className="absolute inset-[18%] rounded-full border-2 border-orange-700/55" />
          <div className="absolute inset-[34%] rounded-full border border-orange-800/75" />
          <div className="absolute inset-0 animate-[spin_2.2s_linear_infinite]">
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-orange-700 shadow-[0_0_0_4px_rgba(194,65,12,0.28)]" />
          </div>
          <div className="absolute inset-[42%] rounded-full bg-orange-700 border-4 border-orange-300" />
        </div>
      )}

      <div className="absolute top-5 inset-x-4 z-20 flex items-center justify-between bg-white/90 backdrop-blur-md rounded-2xl px-4 py-3 shadow">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
            {trackingActive && riderPoint
              ? "Live tracking"
              : POST_PICKUP_STATUSES.has(parcel.status)
                ? "Tracking ended"
                : "Courier pickup"}
          </p>
          <p className="text-sm font-bold text-slate-800 truncate max-w-[200px]">
            {trackingActive && captainAwayText && riderPoint
              ? `Captain is ${captainAwayText}`
              : POST_PICKUP_STATUSES.has(parcel.status)
                ? "Courier handed to captain"
                : parcel.pickupAddress?.fullAddress}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-black px-2.5 py-1 rounded-full uppercase ${
            parcel.status === "DELIVERED" ? "bg-green-100 text-green-700" :
            parcel.status === "CANCELLED" ? "bg-red-100 text-red-600" :
            isSearching ? "bg-amber-100 text-amber-700" :
            "bg-blue-100 text-blue-700"
          }`}>
            {formatStatusLabel(parcel.status)}
          </span>
          <button
            onClick={() => navigate("/parcel")}
            className="h-9 w-9 rounded-full bg-slate-100 flex items-center justify-center"
          >
            <X size={18} className="text-slate-700" />
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 pointer-events-none px-0 sm:px-4 sm:pb-4">
        <div
          className="pointer-events-auto bg-white/95 backdrop-blur-md rounded-t-[28px] sm:rounded-[28px] shadow-[0_16px_40px_rgba(15,23,42,0.20)] border border-slate-100 max-w-[420px] mx-auto flex flex-col min-h-0 will-change-[height]"
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
            className="shrink-0 touch-none select-none cursor-grab active:cursor-grabbing pt-3 pb-2 px-5"
          >
            <div className="h-1.5 w-14 bg-slate-300 rounded-full mx-auto" />
            <p className="mt-1.5 text-center text-[10px] font-bold text-slate-400 tracking-wide">
              Swipe up / down
            </p>
          </div>

          <div
            data-lenis-prevent
            data-lenis-prevent-touch
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-5 pb-5"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
          <h2 className="text-[20px] md:text-[22px] leading-tight font-black text-slate-900 tracking-[-0.01em]">
            {statusUi.title}
          </h2>
          <p className="text-slate-500 text-[13px] md:text-[14px] leading-5 font-semibold mt-2 min-h-[24px]">
            {isSearching ? sliderTexts[sliderIndex] : statusUi.subtitle}
          </p>

          {isSearching ? (
            <>
              <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3.5 mt-3.5 text-center">
                <p className="text-[10px] uppercase font-black tracking-[0.2em] text-amber-700">Expected Price</p>
                <p className="text-[26px] md:text-[30px] leading-none font-black text-slate-900 mt-2">
                  ₹{Number(parcel.fare || 0).toFixed(2)}
                </p>
                <p className="text-[12px] text-slate-500 font-semibold mt-2">
                  Estimated for about {Number(parcel.distance || 0).toFixed(1)} km.
                </p>
              </div>

              <div className="flex justify-center gap-2 mt-4">
                {sliderTexts.map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-2.5 w-2.5 rounded-full transition-all ${
                      idx === sliderIndex
                        ? "bg-orange-500 scale-110 shadow-[0_0_0_3px_rgba(249,115,22,0.2)]"
                        : "bg-slate-300"
                    }`}
                  />
                ))}
              </div>

              <div className="mt-3.5 rounded-2xl bg-slate-100 p-3 flex items-center justify-between text-xs font-black text-slate-700 uppercase tracking-wider">
                <div className="flex items-center gap-2"><Zap size={14} className="text-emerald-500" /> Fast Dispatch</div>
                <div className="flex items-center gap-2"><ShieldCheck size={14} className="text-blue-600" /> Courier Safety</div>
              </div>
            </>
          ) : (
            <div className="mt-3.5 space-y-3">
              <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase font-black tracking-[0.2em] text-slate-400">Fare</p>
                  <p className="text-xl font-black text-slate-900 mt-1">
                    ₹{Number(parcel.fare || 0).toFixed(2)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase font-black tracking-[0.2em] text-slate-400">
                    {trackingActive && captainAwayText ? "Captain distance" : "Trip distance"}
                  </p>
                  <p className="text-sm font-bold text-slate-700 mt-1">
                    {trackingActive && captainAwayText
                      ? captainAwayText
                      : `${Number(parcel.distance || 0).toFixed(1)} km`}
                  </p>
                </div>
              </div>

              {riderName ? (
                <div className="bg-white border border-slate-200 rounded-2xl p-3.5 flex items-center gap-3">
                  <div className="h-11 w-11 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                    <User size={20} className="text-slate-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Delivery captain</p>
                    <p className="text-sm font-black text-slate-900 truncate">{riderName}</p>
                    {riderPhone && trackingActive && (
                      <p className="text-xs text-slate-500 font-semibold flex items-center gap-1 mt-0.5">
                        <Phone size={11} /> {riderPhone}
                      </p>
                    )}
                    {trackingActive && captainAwayText && (
                      <p className="text-xs text-orange-600 font-bold mt-1">
                        Coming to you · {captainAwayText}
                      </p>
                    )}
                    {POST_PICKUP_STATUSES.has(parcel.status) && (
                      <p className="text-xs text-emerald-600 font-bold mt-1">
                        Courier collected · live tracking ended
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="bg-blue-50 border border-blue-100 rounded-2xl p-3.5 flex items-center gap-2 text-xs font-semibold text-blue-800">
                  <Package size={14} /> Captain details will appear here.
                </div>
              )}

              {trackingActive && parcel.otp && (
                <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-3.5 text-center">
                  <p className="text-[10px] uppercase font-black tracking-[0.2em] text-emerald-700">
                    Pickup OTP
                  </p>
                  <p className="text-3xl font-black tracking-[0.25em] text-emerald-900 mt-1">
                    {parcel.otp}
                  </p>
                  <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                    Share this OTP only with your delivery captain when they collect the courier.
                  </p>
                </div>
              )}

              {(parcel.pickupSla?.canRequestLateRefund ||
                parcel.lateRefundRequest?.status === "requested" ||
                parcel.lateRefundRequest?.status === "approved" ||
                parcel.lateRefundRequest?.status === "rejected") && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 space-y-2">
                  <p className="text-[10px] uppercase font-black tracking-[0.2em] text-amber-800">
                    Late pickup (Normal 30 min)
                  </p>
                  {parcel.lateRefundRequest?.status === "requested" && (
                    <p className="text-xs text-amber-900 font-semibold">
                      Refund request is pending admin review. COD / fare collection stays unchanged until then.
                    </p>
                  )}
                  {parcel.lateRefundRequest?.status === "approved" && (
                    <p className="text-xs text-emerald-800 font-semibold">
                      Admin credited ₹{Number(parcel.lateRefundRequest.approvedAmount || 0).toFixed(2)} to your wallet.
                      {String(parcel.paymentMethod).toUpperCase() === "COD"
                        ? " Full COD cash was still collected."
                        : ""}
                    </p>
                  )}
                  {parcel.lateRefundRequest?.status === "rejected" && (
                    <p className="text-xs text-slate-700 font-semibold">
                      Late refund request was rejected
                      {parcel.lateRefundRequest.adminNote
                        ? `: ${parcel.lateRefundRequest.adminNote}`
                        : "."}
                    </p>
                  )}
                  {parcel.pickupSla?.canRequestLateRefund && (
                    <>
                      <p className="text-xs text-amber-900 font-medium leading-snug">
                        Captain took longer than 30 minutes. You can ask admin for a wallet refund.
                        {String(parcel.paymentMethod).toUpperCase() === "COD"
                          ? " COD cash is still collected in full."
                          : ""}
                      </p>
                      <button
                        type="button"
                        disabled={requestingLateRefund}
                        onClick={handleRequestLateRefund}
                        className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-black uppercase tracking-wider disabled:opacity-60"
                      >
                        {requestingLateRefund ? "Submitting..." : "Request late refund"}
                      </button>
                    </>
                  )}
                </div>
              )}

              {parcel.status === "DELIVERED" && (
                <ParcelReviewPrompt parcelId={parcel._id || parcel.id} />
              )}
            </div>
          )}

          {isSearching ? (
            <button
              onClick={handleCancelSearch}
              disabled={cancelling}
              className="w-full mt-4 py-3 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-black uppercase tracking-wider disabled:opacity-60 transition-colors"
            >
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          ) : (
            <button
              onClick={() =>
                navigate(
                  TERMINAL_STATUSES.has(parcel.status)
                    ? "/parcel"
                    : "/profile/parcel-history",
                )
              }
              className="w-full mt-4 py-3 rounded-2xl bg-slate-900 text-white font-black uppercase tracking-wider"
            >
              {TERMINAL_STATUSES.has(parcel.status) ? "Back to Courier" : "Open Courier History"}
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ParcelSearchTrackingPage;
