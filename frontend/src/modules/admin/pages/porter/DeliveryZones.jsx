import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    Plus,
    Search,
    Pencil,
    Trash2,
    Eye,
    Loader2,
    Map as MapIcon,
    Layers,
    Ruler,
    CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import Card from "@shared/components/ui/Card";
import Modal from "@shared/components/ui/Modal";
import Button from "@shared/components/ui/Button";
import ConfirmDialog from "@shared/components/ui/ConfirmDialog";
import PageHeader from "@shared/components/ui/PageHeader";
import StatCard from "@shared/components/ui/StatCard";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import ZoneMapEditor from "./ZoneMapEditor";
import { maskName, checkName, firstError } from "../../utils/formRules";
import { cn } from "@/lib/utils";

const SWATCHES = ["#2563EB", "#059669", "#D97706", "#DC2626", "#7C3AED", "#0891B2"];

const emptyForm = {
    name: "",
    city: "",
    color: SWATCHES[0],
    isActive: true,
};

/**
 * A cheap shape preview for the list.
 *
 * The alternative is a Google Map per row, which would mean one map instance
 * and one tile bill for every zone on screen just to show an outline.
 */
const ZoneThumb = ({ points = [], color }) => {
    const path = useMemo(() => {
        if (points.length < 3) return null;

        const lats = points.map((p) => p.lat);
        const lngs = points.map((p) => p.lng);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);
        const spanLat = maxLat - minLat || 1e-6;
        const spanLng = maxLng - minLng || 1e-6;
        const span = Math.max(spanLat, spanLng);

        // Centre the shape in a square box, keeping its aspect ratio.
        const offsetX = (span - spanLng) / 2;
        const offsetY = (span - spanLat) / 2;

        return points
            .map((p) => {
                const x = ((p.lng - minLng + offsetX) / span) * 88 + 6;
                // SVG y grows downward; latitude grows upward.
                const y = 94 - (((p.lat - minLat + offsetY) / span) * 88 + 6);
                return `${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");
    }, [points]);

    if (!path) {
        return (
            <div className="grid h-[76px] w-[76px] shrink-0 place-items-center rounded-2xl bg-slate-100 dark:bg-slate-800">
                <MapIcon className="h-5 w-5 text-slate-400" />
            </div>
        );
    }

    return (
        <svg
            viewBox="0 0 100 100"
            className="h-[76px] w-[76px] shrink-0 rounded-2xl bg-slate-50 dark:bg-slate-800"
            aria-hidden
        >
            <polygon
                points={path}
                fill={color}
                fillOpacity="0.22"
                stroke={color}
                strokeWidth="2.5"
                strokeLinejoin="round"
            />
        </svg>
    );
};

const DeliveryZones = () => {
    const [zones, setZones] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [status, setStatus] = useState("all");

    const [editing, setEditing] = useState(null); // zone being edited, or {} for new
    const [form, setForm] = useState(emptyForm);
    const [points, setPoints] = useState([]);
    const [saving, setSaving] = useState(false);

    const [viewing, setViewing] = useState(null);

    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);

    const fetchZones = useCallback(async () => {
        try {
            const params = {};
            if (search.trim()) params.search = search.trim();
            if (status !== "all") params.status = status;

            const res = await adminPorterApi.getZones(params);
            if (res.data.success) setZones(res.data.results || []);
        } catch (error) {
            console.error("Zones fetch failed:", error);
            toast.error(error?.response?.data?.message || "Failed to load zones");
        } finally {
            setLoading(false);
        }
    }, [search, status]);

    useEffect(() => {
        const timer = setTimeout(fetchZones, search ? 350 : 0);
        return () => clearTimeout(timer);
    }, [fetchZones, search]);

    const summary = useMemo(() => {
        const active = zones.filter((z) => z.isActive).length;
        const area = zones.reduce((sum, z) => sum + (z.areaSqKm || 0), 0);
        return { total: zones.length, active, area };
    }, [zones]);

    const openCreate = () => {
        setForm(emptyForm);
        setPoints([]);
        setEditing({});
    };

    const openEdit = (zone) => {
        setForm({
            name: zone.name || "",
            city: zone.city || "",
            color: zone.color || SWATCHES[0],
            isActive: zone.isActive !== false,
        });
        setPoints(zone.points || []);
        setEditing(zone);
    };

    const closeEditor = () => {
        setEditing(null);
        setPoints([]);
        setForm(emptyForm);
    };

    const handlePlaceSelect = useCallback((place) => {
        if (!place) return;
        const components = place.address_components || [];
        const locality = components.find((c) => c.types.includes("locality"))?.long_name;
        const admin2 = components.find((c) => c.types.includes("administrative_area_level_2"))?.long_name;
        const admin1 = components.find((c) => c.types.includes("administrative_area_level_1"))?.long_name;
        const resolvedCity = locality || admin2 || admin1 || "";

        const placeName = place.name || (place.formatted_address ? place.formatted_address.split(",")[0].trim() : "");

        setForm((prev) => ({
            ...prev,
            city: prev.city.trim() ? prev.city : (resolvedCity || prev.city),
            name: prev.name.trim() ? prev.name : (placeName || resolvedCity || prev.name),
        }));
    }, []);

    const handleSave = async () => {
        const invalid = firstError(
            checkName(form.name, "Zone name"),
            form.city ? checkName(form.city, "City") : null,
        );
        if (invalid) {
            toast.error(invalid);
            return;
        }
        if (points.length < 3) {
            toast.error("Draw at least 3 points on the map");
            return;
        }

        setSaving(true);
        try {
            const payload = {
                ...form,
                name: form.name.trim(),
                points,
            };

            const res = editing?._id
                ? await adminPorterApi.updateZone(editing._id, payload)
                : await adminPorterApi.createZone(payload);

            if (res.data.success) {
                toast.success(editing?._id ? "Zone updated" : "Zone created");
                closeEditor();
                fetchZones();
            }
        } catch (error) {
            console.error("Zone save failed:", error);
            toast.error(error?.response?.data?.message || "Could not save the zone");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            const res = await adminPorterApi.deleteZone(deleteTarget._id);
            if (res.data.success) {
                toast.success("Zone deleted");
                setDeleteTarget(null);
                fetchZones();
            }
        } catch (error) {
            console.error("Zone delete failed:", error);
            toast.error(error?.response?.data?.message || "Could not delete the zone");
        } finally {
            setDeleting(false);
        }
    };


    const otherZones = useMemo(
        () => zones.filter((z) => z._id !== editing?._id && (z.points?.length || 0) >= 3),
        [zones, editing],
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Delivery Zones"
                description="Draw the areas the courier fleet serves."
                icon={Layers}
                actions={
                    <Button onClick={openCreate} className="gap-2">
                        <Plus className="h-4 w-4" /> New Zone
                    </Button>
                }
            />

            <div className="ds-grid-cards-3">
                {[
                    { label: "Total Zones", value: summary.total, icon: Layers },
                    { label: "Active", value: summary.active, icon: CheckCircle2, color: "text-orange-600", bg: "bg-orange-50 border border-orange-200" },
                    {
                        label: "Coverage",
                        value: `${summary.area.toFixed(1)} km²`,
                        icon: Ruler,
                        color: "text-orange-600",
                        bg: "bg-orange-50 border border-orange-200",
                    },
                ].map((stat) => (
                    <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} color={stat.color} bg={stat.bg} />
                ))}
            </div>

            <Card className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by name or city…"
                            className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-2.5 pl-10 pr-3 text-sm font-medium outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-900"
                        />
                    </div>
                    <select
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                        className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm font-semibold outline-none dark:border-slate-700 dark:bg-slate-900"
                    >
                        <option value="all">All statuses</option>
                        <option value="active">Active only</option>
                        <option value="inactive">Inactive only</option>
                    </select>
                </div>
            </Card>

            {loading ? (
                <div className="flex h-64 items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            ) : zones.length === 0 ? (
                <Card>
                    <EmptyState
                        icon={MapIcon}
                        title="No zones yet"
                        description="Draw your first serviceable area on the map to start routing courier couriers by zone."
                        action={
                            <Button onClick={openCreate} className="gap-2">
                                <Plus className="h-4 w-4" /> Create a zone
                            </Button>
                        }
                    />
                </Card>
            ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {zones.map((zone) => (
                        <Card key={zone._id} className="p-5">
                            <div className="flex gap-4">
                                <ZoneThumb points={zone.points} color={zone.color} />

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <h3 className="truncate text-base font-extrabold text-slate-900 dark:text-white">
                                                {zone.name}
                                            </h3>
                                            <p className="mt-0.5 truncate text-xs font-medium text-slate-500">
                                                {zone.city || "No city set"}
                                            </p>
                                        </div>
                                        <Badge variant={zone.isActive ? "success" : "gray"} className="shrink-0">
                                            {zone.isActive ? "Active" : "Inactive"}
                                        </Badge>
                                    </div>

                                    <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                                        {[
                                            { label: "Area", value: `${(zone.areaSqKm || 0).toFixed(1)} km²` },
                                            { label: "Corners", value: zone.points?.length || 0 },
                                        ].map((cell) => (
                                            <div
                                                key={cell.label}
                                                className="rounded-xl bg-slate-50 py-2 dark:bg-slate-800/60"
                                            >
                                                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                                    {cell.label}
                                                </p>
                                                <p className="font-mono text-sm font-bold text-slate-800 dark:text-slate-100">
                                                    {cell.value}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                                <button
                                    onClick={() => {
                                        setViewing(zone);
                                    }}
                                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:opacity-90"
                                >
                                    <Eye className="h-3.5 w-3.5" /> View
                                </button>
                                <button
                                    onClick={() => openEdit(zone)}
                                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:opacity-90"
                                >
                                    <Pencil className="h-3.5 w-3.5" /> Edit
                                </button>
                                <button
                                    onClick={() => setDeleteTarget(zone)}
                                    className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-red-600 transition hover:bg-red-50 dark:hover:bg-red-950/40"
                                >
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                </button>
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            {/* Create / edit */}
            <Modal
                isOpen={Boolean(editing)}
                onClose={closeEditor}
                title={editing?._id ? `Edit ${editing.name}` : "New Delivery Zone"}
                size="xl"
                footer={
                    <>
                        <Button variant="outline" onClick={closeEditor} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} isLoading={saving}>
                            {editing?._id ? "Save changes" : "Create zone"}
                        </Button>
                    </>
                }
            >
                <div className="space-y-5">
                    <ZoneMapEditor
                        points={points}
                        onChange={setPoints}
                        color={form.color}
                        otherZones={otherZones}
                        height={380}
                        onPlaceSelect={handlePlaceSelect}
                    />

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <label className="space-y-1.5">
                            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                                Zone name
                            </span>
                            <input
                                value={form.name}
                                onChange={(e) =>
                                    setForm({ ...form, name: maskName(e.target.value, 80) })
                                }
                                placeholder="South Bengaluru"
                                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-900"
                            />
                        </label>
                        <label className="space-y-1.5">
                            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                                City
                            </span>
                            <input
                                value={form.city}
                                onChange={(e) =>
                                    setForm({ ...form, city: maskName(e.target.value, 60) })
                                }
                                placeholder="Bengaluru"
                                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-900"
                            />
                        </label>
                        <div className="space-y-1.5">
                            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                                Colour
                            </span>
                            <div className="flex items-center gap-2 pt-1">
                                {SWATCHES.map((swatch) => (
                                    <button
                                        key={swatch}
                                        type="button"
                                        onClick={() => setForm({ ...form, color: swatch })}
                                        aria-label={`Use ${swatch}`}
                                        className={cn(
                                            "h-7 w-7 rounded-lg border-2 transition",
                                            form.color === swatch
                                                ? "scale-110 border-slate-900 dark:border-white"
                                                : "border-transparent",
                                        )}
                                        style={{ backgroundColor: swatch }}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>

                    <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-slate-50 p-3.5 dark:bg-slate-800/60">
                        <input
                            type="checkbox"
                            checked={form.isActive}
                            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                            className="h-4 w-4 accent-primary"
                        />
                        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                            Zone is active and accepting couriers
                        </span>
                    </label>
                </div>
            </Modal>

            {/* View */}
            <Modal
                isOpen={Boolean(viewing)}
                onClose={() => setViewing(null)}
                title={viewing?.name || "Zone"}
                size="xl"
                footer={
                    <Button variant="outline" onClick={() => setViewing(null)}>
                        Close
                    </Button>
                }
            >
                {viewing && (
                    <div className="space-y-5">
                        <ZoneMapEditor
                            points={viewing.points || []}
                            color={viewing.color}
                            readOnly
                            height={360}
                        />

                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { label: "Area", value: `${(viewing.areaSqKm || 0).toFixed(2)} km²` },
                                { label: "Corners", value: viewing.points?.length || 0 },
                            ].map((cell) => (
                                <div
                                    key={cell.label}
                                    className="rounded-xl bg-slate-50 p-3 text-center dark:bg-slate-800/60"
                                >
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                        {cell.label}
                                    </p>
                                    <p className="mt-0.5 font-mono text-base font-extrabold text-slate-900 dark:text-white">
                                        {cell.value}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </Modal>

            <ConfirmDialog
                isOpen={Boolean(deleteTarget)}
                title="Delete this zone?"
                message={`"${deleteTarget?.name}" will be removed permanently. Couriers already booked are not affected.`}
                confirmLabel="Delete zone"
                variant="danger"
                loading={deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleteTarget(null)}
            />
        </div>
    );
};

export default DeliveryZones;
