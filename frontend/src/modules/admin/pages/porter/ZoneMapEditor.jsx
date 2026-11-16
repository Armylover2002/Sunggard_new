import React, { useCallback, useEffect, useRef, useState } from "react";
import { GoogleMap, Polygon, Autocomplete } from "@react-google-maps/api";
import { Search, Undo2, Trash2, Loader2, MapPin, MousePointerClick } from "lucide-react";
import { useMapsLoader, hasMapsKey } from "@core/maps/useMapsLoader";
import { cn } from "@/lib/utils";

/**
 * Draws and edits one delivery-zone polygon.
 *
 * Vertices are added by clicking the map and adjusted by dragging Google's own
 * handles, rather than through the Drawing library. The maps loader keeps a
 * single frozen library list for the whole app, so pulling in `drawing` here
 * would change what every other map on the site downloads — a cost this screen
 * does not need to impose to collect a ring of points.
 */

const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 }; // India

const containerStyle = { width: "100%", height: "100%" };

const mapOptions = {
    disableDefaultUI: true,
    zoomControl: true,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    clickableIcons: false,
};

const ZoneMapEditor = ({
    points = [],
    onChange,
    color = "#2563EB",
    readOnly = false,
    otherZones = [],
    height = 460,
    onPlaceSelect,
}) => {
    const { isLoaded, loadError } = useMapsLoader();
    const [center, setCenter] = useState(DEFAULT_CENTER);

    const mapRef = useRef(null);
    const polygonRef = useRef(null);
    const pathListenersRef = useRef([]);
    const autocompleteRef = useRef(null);
    const hasFittedRef = useRef(false);
    const suppressMapClickUntilRef = useRef(0);

    // Suppress accidental map clicks when selecting from the autocomplete dropdown
    useEffect(() => {
        const handleGlobalPointerDown = (e) => {
            const isPac = e.target instanceof Element && Boolean(e.target.closest('.pac-container, .pac-item'));
            if (isPac) {
                suppressMapClickUntilRef.current = Date.now() + 600;
            }
        };

        window.addEventListener("pointerdown", handleGlobalPointerDown, true);
        window.addEventListener("mousedown", handleGlobalPointerDown, true);
        return () => {
            window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
            window.removeEventListener("mousedown", handleGlobalPointerDown, true);
        };
    }, []);

    // Google's edit handles mutate the polygon's own path, not React state.
    // The listeners below read it back — through a ref so they never capture a
    // stale `onChange` from the render that installed them.
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    });

    const readBackPath = useCallback(() => {
        const polygon = polygonRef.current;
        if (!polygon) return;
        const next = polygon
            .getPath()
            .getArray()
            .map((latLng) => ({ lat: latLng.lat(), lng: latLng.lng() }));
        onChangeRef.current?.(next);
    }, []);

    const handlePolygonLoad = useCallback(
        (polygon) => {
            polygonRef.current = polygon;
            if (readOnly) return;
            const path = polygon.getPath();
            pathListenersRef.current = [
                path.addListener("set_at", readBackPath),
                path.addListener("insert_at", readBackPath),
                path.addListener("remove_at", readBackPath),
            ];
        },
        [readOnly, readBackPath],
    );

    const handlePolygonUnmount = useCallback(() => {
        pathListenersRef.current.forEach((listener) => listener.remove());
        pathListenersRef.current = [];
        polygonRef.current = null;
    }, []);

    /** Frames an existing zone once, so opening one for edit lands on it. */
    const handleMapLoad = useCallback(
        (map) => {
            mapRef.current = map;
            if (hasFittedRef.current || points.length < 3 || !window.google?.maps) return;

            const bounds = new window.google.maps.LatLngBounds();
            points.forEach((p) => bounds.extend(p));
            map.fitBounds(bounds, 48);
            hasFittedRef.current = true;
        },
        [points],
    );

    const handleMapClick = useCallback(
        (event) => {
            if (readOnly) return;
            if (Date.now() < suppressMapClickUntilRef.current) return;
            const next = [
                ...points,
                { lat: event.latLng.lat(), lng: event.latLng.lng() },
            ];
            onChangeRef.current?.(next);
        },
        [points, readOnly],
    );

    const handlePlaceChanged = () => {
        suppressMapClickUntilRef.current = Date.now() + 600;
        const place = autocompleteRef.current?.getPlace();
        if (!place?.geometry?.location) return;
        const target = {
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng(),
        };
        setCenter(target);
        if (place.geometry.viewport && mapRef.current) {
            mapRef.current.fitBounds(place.geometry.viewport);
        } else if (mapRef.current) {
            mapRef.current.panTo(target);
            mapRef.current.setZoom(13);
        }
        onPlaceSelect?.(place);
    };

    const undoLastPoint = () => onChangeRef.current?.(points.slice(0, -1));
    const clearPoints = () => onChangeRef.current?.([]);

    useEffect(() => () => handlePolygonUnmount(), [handlePolygonUnmount]);

    if (!hasMapsKey()) {
        return (
            <div
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-center dark:border-slate-700 dark:bg-slate-900/60"
                style={{ height }}
            >
                <MapPin className="h-7 w-7 text-slate-400" />
                <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                    Google Maps key not configured
                </p>
                <p className="max-w-xs text-xs text-slate-400">
                    Set VITE_GOOGLE_MAPS_API_KEY to draw zone boundaries.
                </p>
            </div>
        );
    }

    if (loadError) {
        return (
            <div
                className="flex items-center justify-center rounded-2xl border border-red-200 bg-red-50 text-sm font-semibold text-red-600"
                style={{ height }}
            >
                Failed to load Google Maps.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[200px] flex-1">
                        {isLoaded && (
                            <Autocomplete
                                onLoad={(ref) => (autocompleteRef.current = ref)}
                                onPlaceChanged={handlePlaceChanged}
                                options={{
                                    componentRestrictions: { country: "IN" },
                                    fields: ["geometry", "formatted_address", "name", "address_components"],
                                }}
                            >
                                <div className="relative">
                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                    <input
                                        placeholder="Jump to an area…"
                                        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm font-medium outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-900"
                                    />
                                </div>
                            </Autocomplete>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={undoLastPoint}
                        disabled={points.length === 0}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                        <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                    <button
                        type="button"
                        onClick={clearPoints}
                        disabled={points.length === 0}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-bold text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900/60 dark:bg-red-950/40"
                    >
                        <Trash2 className="h-3.5 w-3.5" /> Clear
                    </button>
                </div>
            )}

            <div
                className="relative overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700"
                style={{ height }}
            >
                {!isLoaded ? (
                    <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-900">
                        <Loader2 className="h-7 w-7 animate-spin text-primary" />
                    </div>
                ) : (
                    <GoogleMap
                        mapContainerStyle={containerStyle}
                        center={center}
                        zoom={5}
                        onLoad={handleMapLoad}
                        onClick={handleMapClick}
                        options={mapOptions}
                    >
                        {/* Neighbouring zones, for context only. */}
                        {otherZones.map((zone) => (
                            <Polygon
                                key={zone._id}
                                path={zone.points || []}
                                options={{
                                    fillColor: zone.color || "#94A3B8",
                                    fillOpacity: 0.08,
                                    strokeColor: zone.color || "#94A3B8",
                                    strokeOpacity: 0.5,
                                    strokeWeight: 1.5,
                                    clickable: false,
                                    zIndex: 1,
                                }}
                            />
                        ))}

                        {points.length > 0 && (
                            <Polygon
                                path={points}
                                onLoad={handlePolygonLoad}
                                onUnmount={handlePolygonUnmount}
                                onMouseUp={readOnly ? undefined : readBackPath}
                                options={{
                                    fillColor: color,
                                    fillOpacity: 0.22,
                                    strokeColor: color,
                                    strokeOpacity: 0.95,
                                    strokeWeight: 2.5,
                                    editable: !readOnly,
                                    clickable: false,
                                    zIndex: 2,
                                }}
                            />
                        )}
                    </GoogleMap>
                )}

                {!readOnly && (
                    <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900/85 px-3 py-2 text-[11px] font-bold text-white backdrop-blur-sm">
                            <MousePointerClick className="h-3.5 w-3.5" />
                            {points.length === 0
                                ? "Click the map to drop the first corner"
                                : "Click to add · drag a handle to adjust"}
                        </span>
                        <span
                            className={cn(
                                "rounded-xl px-3 py-2 font-mono text-[11px] font-bold backdrop-blur-sm",
                                points.length >= 3
                                    ? "bg-brand-600/90 text-white"
                                    : "bg-amber-500/90 text-white",
                            )}
                        >
                            {points.length} {points.length === 1 ? "point" : "points"}
                            {points.length < 3 && " · need 3"}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ZoneMapEditor;
