import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  Calendar,
  Clock,
  Sparkles,
  ExternalLink,
  Upload,
  Image as ImageIcon,
  CheckCircle2,
  XCircle,
  AlertCircle,
  BarChart2,
  RotateCcw,
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
import axiosInstance from "@core/api/axios";
import { invalidateCache } from "@core/api/dedupe";
import { adminPorterApi } from "../../services/api/porterApi";
import { cn } from "@/lib/utils";

const STATUS_CONFIG = {
  active: {
    label: "Active Now",
    bg: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800",
    icon: CheckCircle2,
  },
  scheduled: {
    label: "Scheduled",
    bg: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800",
    icon: Clock,
  },
  default: {
    label: "Always Show (Default)",
    bg: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800",
    icon: Sparkles,
  },
  expired: {
    label: "Expired",
    bg: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-800",
    icon: XCircle,
  },
  inactive: {
    label: "Disabled",
    bg: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800",
    icon: AlertCircle,
  },
};

const emptyForm = {
  title: "",
  subtitle: "",
  imageUrl: "",
  isDefault: false,
  startDate: "",
  endDate: "",
  displayOrder: 0,
  serviceType: "all",
  isActive: true,
};

const formatDateForInput = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  // Format to YYYY-MM-DDTHH:mm for datetime-local input
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatDateDisplay = (dateStr) => {
  if (!dateStr) return "Not set";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Invalid date";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const PorterBanners = () => {
  const [banners, setBanners] = useState([]);
  const [counts, setCounts] = useState({
    total: 0,
    active: 0,
    scheduled: 0,
    expired: 0,
    default: 0,
    inactive: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Modal form state
  const [editing, setEditing] = useState(null); // null = closed, {} = new, obj = edit
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef(null);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Preview modal
  const [previewBanner, setPreviewBanner] = useState(null);

  const loadBanners = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminPorterApi.getBanners({
        search: search.trim() || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
      });

      const data = res?.data?.result || res?.data?.results || res?.data?.data || {};
      if (Array.isArray(data)) {
        setBanners(data);
      } else {
        setBanners(data.banners || []);
        if (data.counts) {
          setCounts(data.counts);
        }
      }
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to load banners");
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    loadBanners();
  }, [loadBanners]);

  const handleOpenCreate = () => {
    // Default start date = now, end date = 7 days later
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    setForm({
      ...emptyForm,
      startDate: formatDateForInput(now),
      endDate: formatDateForInput(nextWeek),
    });
    setEditing({});
  };

  const handleOpenEdit = (banner) => {
    setForm({
      title: banner.title || "",
      subtitle: banner.subtitle || "",
      imageUrl: banner.imageUrl || "",
      isDefault: Boolean(banner.isDefault),
      startDate: formatDateForInput(banner.startDate),
      endDate: formatDateForInput(banner.endDate),
      displayOrder: banner.displayOrder || 0,
      serviceType: banner.serviceType || "all",
      isActive: banner.isActive !== undefined ? banner.isActive : true,
    });
    setEditing(banner);
  };

  const handleImageFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please choose a valid image file");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image size must be less than 5MB");
      return;
    }

    try {
      setUploadingImage(true);
      const formData = new FormData();
      formData.append("file", file);

      const res = await axiosInstance.post("/media/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const url =
        res.data?.result?.url ||
        res.data?.result?.secureUrl ||
        res.data?.data?.url ||
        res.data?.url ||
        "";

      if (!url) {
        throw new Error("No URL returned from server");
      }

      setForm((prev) => ({ ...prev, imageUrl: url }));
      toast.success("Image uploaded successfully");
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to upload image");
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const applyDatePreset = (presetKey) => {
    const now = new Date();
    const startStr = formatDateForInput(now);
    let end;

    if (presetKey === "today") {
      // Full day today until 23:59
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
    } else if (presetKey === "3days") {
      end = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    } else if (presetKey === "7days") {
      end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (presetKey === "30days") {
      end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    setForm((prev) => ({
      ...prev,
      startDate: startStr,
      endDate: formatDateForInput(end),
    }));
  };

  const handleStartDateChange = (val) => {
    setForm((prev) => {
      const next = { ...prev, startDate: val };
      if (val && prev.endDate) {
        const s = new Date(val).getTime();
        const e = new Date(prev.endDate).getTime();
        if (!isNaN(s) && !isNaN(e) && e <= s) {
          // Automatically advance endDate if user pushed start beyond end
          const autoEnd = new Date(s + 24 * 60 * 60 * 1000);
          next.endDate = formatDateForInput(autoEnd);
        }
      }
      return next;
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();

    if (!form.imageUrl.trim()) {
      toast.error("Banner image is required");
      return;
    }

    if (!form.isDefault) {
      if (!form.startDate) {
        toast.error("Please specify a start date and time");
        return;
      }
      if (!form.endDate) {
        toast.error("Please specify an end date and time");
        return;
      }
      const s = new Date(form.startDate).getTime();
      const e = new Date(form.endDate).getTime();
      if (isNaN(s) || isNaN(e)) {
        toast.error("Start or end date is invalid");
        return;
      }
      if (e <= s) {
        toast.error("End date and time must be strictly later than start date and time");
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        subtitle: form.subtitle.trim(),
        imageUrl: form.imageUrl.trim(),
        isDefault: form.isDefault,
        startDate: form.isDefault ? null : form.startDate,
        endDate: form.isDefault ? null : form.endDate,
        displayOrder: Number(form.displayOrder) || 0,
        serviceType: form.serviceType,
        isActive: form.isActive,
      };

      if (editing?._id) {
        await adminPorterApi.updateBanner(editing._id, payload);
        toast.success("Banner updated successfully");
      } else {
        await adminPorterApi.createBanner(payload);
        toast.success("Banner created successfully");
      }

      invalidateCache("/porter/banners");
      setEditing(null);
      loadBanners();
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to save banner");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (banner) => {
    try {
      await adminPorterApi.toggleBannerStatus(banner._id);
      invalidateCache("/porter/banners");
      toast.success(`Banner ${banner.isActive ? "disabled" : "activated"}`);
      loadBanners();
    } catch (err) {
      console.error(err);
      toast.error("Failed to toggle status");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await adminPorterApi.deleteBanner(deleteTarget._id);
      invalidateCache("/porter/banners");
      toast.success("Banner deleted successfully");
      setDeleteTarget(null);
      loadBanners();
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to delete banner");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <PageHeader
        title="Courier App Banners"
        description='Create promotional or informational banners displayed above "Start a Shipment" on the Courier app.'
        badge={<Badge variant="warning">Courier Ops</Badge>}
        actions={
          <Button onClick={handleOpenCreate} icon={Plus} className="shrink-0 bg-primary text-white">
            Add New Banner
          </Button>
        }
      />

      {/* Metric Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          label="Total Banners"
          value={counts.total}
          icon={BarChart2}
          color="text-slate-600"
          bg="bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700"
        />
        <StatCard
          label="Active Now"
          value={counts.active}
          icon={CheckCircle2}
          color="text-orange-600"
          bg="bg-orange-50 border border-orange-200 dark:bg-orange-950/40 dark:border-orange-800"
        />
        <StatCard
          label="Scheduled"
          value={counts.scheduled}
          icon={Clock}
          color="text-orange-600"
          bg="bg-orange-50 border border-orange-200 dark:bg-orange-950/40 dark:border-orange-800"
        />
        <StatCard
          label="Always Show"
          value={counts.default}
          icon={Sparkles}
          color="text-orange-600"
          bg="bg-orange-50 border border-orange-200 dark:bg-orange-950/40 dark:border-orange-800"
        />
        <StatCard
          className="col-span-2 sm:col-span-1"
          label="Expired / Off"
          value={counts.expired + counts.inactive}
          icon={XCircle}
          color="text-slate-600"
          bg="bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700"
        />
      </div>

      {/* Filter & Search Bar */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Status Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
            {[
              { id: "all", label: "All" },
              { id: "active", label: "Active" },
              { id: "scheduled", label: "Scheduled" },
              { id: "default", label: "Always Show" },
              { id: "expired", label: "Expired" },
              { id: "inactive", label: "Disabled" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  statusFilter === tab.id
                    ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search input */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search banners..."
              className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </div>
        </div>
      </Card>

      {/* Banner List */}
      {loading ? (
        <div className="flex h-60 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : banners.length === 0 ? (
        <Card>
          <EmptyState
            icon={ImageIcon}
            title="No banners found"
            description={
              search || statusFilter !== "all"
                ? "Try adjusting your filters or search terms."
                : "Get started by creating your first banner for the Courier home screen."
            }
            action={
              <Button onClick={handleOpenCreate} icon={Plus} className="bg-primary text-white">
                Create Banner
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {banners.map((b) => {
            const statusMeta = STATUS_CONFIG[b.status] || STATUS_CONFIG.inactive;
            const StatusIcon = statusMeta.icon;

            return (
              <Card
                key={b._id}
                className={cn(
                  "overflow-hidden transition-all hover:shadow-md",
                  !b.isActive && "opacity-75"
                )}
              >
                {/* Banner Thumbnail */}
                <div
                  className="group relative aspect-[21/9] w-full cursor-pointer overflow-hidden bg-slate-100 dark:bg-slate-800"
                  onClick={() => setPreviewBanner(b)}
                >
                  <img
                    src={b.imageUrl}
                    alt={b.title || "Banner"}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src =
                        "https://placehold.co/600x260/1e293b/ffffff?text=Banner+Image+Error";
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 flex items-end p-3">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-white">
                      Click to preview
                    </span>
                  </div>

                  {/* Status chip */}
                  <div className="absolute left-2.5 top-2.5">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold backdrop-blur-md shadow-sm",
                        statusMeta.bg
                      )}
                    >
                      <StatusIcon className="h-3 w-3" />
                      {statusMeta.label}
                    </span>
                  </div>

                  {/* Display Order */}
                  <div className="absolute right-2.5 top-2.5">
                    <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-mono font-bold text-white backdrop-blur-sm">
                      Order: {b.displayOrder ?? 0}
                    </span>
                  </div>
                </div>

                {/* Content Details */}
                <div className="p-4 space-y-3">
                  <div>
                    <h3 className="font-semibold text-slate-900 line-clamp-1 dark:text-white">
                      {b.title || <span className="text-slate-400 italic">No Title (Image Only)</span>}
                    </h3>
                    {b.subtitle && (
                      <p className="mt-0.5 text-xs text-slate-500 line-clamp-2 dark:text-slate-400">
                        {b.subtitle}
                      </p>
                    )}
                  </div>

                  {/* Metadata / Schedule */}
                  <div className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Schedule:</span>
                      <span className="font-medium text-right truncate">
                        {b.isDefault ? (
                          <span className="font-semibold text-orange-600 dark:text-orange-400">
                            Always Active (Default)
                          </span>
                        ) : (
                          `${formatDateDisplay(b.startDate)} → ${formatDateDisplay(b.endDate)}`
                        )}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-400">
                      <span>Service: <strong className="text-slate-700 dark:text-slate-200 capitalize">{b.serviceType || "all"}</strong></span>
                      <span>Order: <strong className="text-slate-700 dark:text-slate-200">{b.displayOrder ?? 0}</strong></span>
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(b)}
                      title={b.isActive ? "Click to disable banner" : "Click to activate banner"}
                      className="group inline-flex items-center gap-2 text-xs font-semibold"
                    >
                      <span
                        className={cn(
                          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                          b.isActive ? "bg-orange-500" : "bg-slate-300 dark:bg-slate-700"
                        )}
                      >
                        <span
                          className={cn(
                            "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out",
                            b.isActive ? "translate-x-4" : "translate-x-0"
                          )}
                        />
                      </span>
                      <span
                        className={cn(
                          "transition-colors",
                          b.isActive
                            ? "text-orange-600 dark:text-orange-400"
                            : "text-slate-400 dark:text-slate-500"
                        )}
                      >
                        {b.isActive ? "Enabled" : "Disabled"}
                      </span>
                    </button>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(b)}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:opacity-90 dark:hover:text-slate-200"
                        title="Edit Banner"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeleteTarget(b)}
                        className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/40"
                        title="Delete Banner"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal: Create / Edit Banner */}
      <Modal
        isOpen={Boolean(editing)}
        onClose={() => !saving && setEditing(null)}
        title={editing?._id ? "Edit Banner" : "Create New Banner"}
        maxWidth="max-w-xl"
      >
        <form onSubmit={handleSave} className="space-y-4 pt-2">
          {/* Image Upload & URL */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Banner Image <span className="text-rose-500">*</span>
            </label>

            {/* Image Preview Box */}
            <div className="mt-2 relative aspect-[21/9] w-full overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
              {form.imageUrl ? (
                <>
                  <img
                    src={form.imageUrl}
                    alt="Banner preview"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src =
                        "https://placehold.co/600x260/1e293b/ffffff?text=Image+Load+Failed";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, imageUrl: "" }))}
                    className="absolute right-2 top-2 rounded-lg bg-black/70 px-2 py-1 text-xs text-white backdrop-blur-sm hover:bg-[color:var(--primary)]"
                  >
                    Change
                  </button>
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center p-4 text-center">
                  <ImageIcon className="h-8 w-8 text-slate-400" />
                  <p className="mt-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                    Upload banner image (recommended 824 x 380 px)
                  </p>
                  <p className="text-[11px] text-slate-400">JPG, PNG, WebP up to 5MB</p>

                  <div className="mt-3 flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageFileChange}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      icon={uploadingImage ? Loader2 : Upload}
                      disabled={uploadingImage}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploadingImage ? "Uploading..." : "Choose Image File"}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Direct Image URL input */}
            <div className="mt-2">
              <input
                type="url"
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                placeholder="Or paste direct image URL (https://...)"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Title & Subtitle */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Title / Headline (Optional)
              </label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. 50% Off on First Intra-City Delivery"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Subtitle (Optional)
              </label>
              <input
                type="text"
                value={form.subtitle}
                onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                placeholder="e.g. Doorstep pickup with live OTP tracking"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Default / Always Show Switch */}
          <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-3.5 dark:border-orange-900/50 dark:bg-orange-950/20">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="block text-xs font-bold text-orange-900 dark:text-orange-200">
                  Always Show (Default Banner)
                </span>
                <span className="block text-[11px] text-orange-700 dark:text-orange-400">
                  Does not expire. Acts as fallback when no time-specific promotions are running.
                </span>
              </div>
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
                className="h-4 w-4 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
              />
            </label>
          </div>

          {/* Start & End Dates (shown when not Default) */}
          {!form.isDefault && (
            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-900/40">
              {/* Quick Duration Presets */}
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Quick Duration Presets:
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { key: "today", label: "Today (Full Day)" },
                    { key: "3days", label: "3 Days" },
                    { key: "7days", label: "7 Days" },
                    { key: "30days", label: "30 Days" },
                  ].map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => applyDatePreset(p.key)}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Start Date & Time <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={form.startDate}
                    min={editing?._id ? undefined : formatDateForInput(new Date())}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    End Date & Time <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={form.endDate}
                    min={form.startDate || formatDateForInput(new Date())}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  />
                </div>
              </div>

              {/* Live helper notes */}
              {form.startDate && form.endDate && (
                <div className="pt-1">
                  {new Date(form.endDate).getTime() <= new Date(form.startDate).getTime() ? (
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      End date & time must be strictly later than start date & time.
                    </p>
                  ) : new Date(form.startDate).toDateString() === new Date(form.endDate).toDateString() ? (
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      Same-Day Banner: Active today from{" "}
                      {new Date(form.startDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                      to{" "}
                      {new Date(form.endDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* Service & Display Order */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Target Service
              </label>
              <select
                value={form.serviceType}
                onChange={(e) => setForm({ ...form, serviceType: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                {/* LOCAL CITY PARCEL DISABLED — "Local Delivery Only" option removed;
                    local bookings can no longer be created so a local-only banner would
                    never be seen. "all" is kept for existing banners saved with it. */}
                <option value="all">All</option>
                <option value="outstation">Courier Only</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Display Order (Priority)
              </label>
              <input
                type="number"
                value={form.displayOrder}
                onChange={(e) => setForm({ ...form, displayOrder: e.target.value })}
                placeholder="0 = first"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Active Switch */}
          <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
            <div>
              <span className="block text-xs font-bold text-slate-800 dark:text-white">
                Active Status
              </span>
              <span className="block text-[11px] text-slate-500">
                Turn off to instantly hide this banner without deleting it.
              </span>
            </div>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || uploadingImage}
              icon={saving ? Loader2 : CheckCircle2}
              className="bg-primary text-white"
            >
              {saving ? "Saving..." : editing?._id ? "Update Banner" : "Create Banner"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Banner Preview */}
      <Modal
        isOpen={Boolean(previewBanner)}
        onClose={() => setPreviewBanner(null)}
        title="Banner Live Preview"
        maxWidth="max-w-lg"
      >
        {previewBanner && (
          <div className="space-y-4 pt-2">
            <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-md dark:border-slate-800">
              <img
                src={previewBanner.imageUrl}
                alt={previewBanner.title || "Banner preview"}
                className="w-full object-cover"
              />
            </div>

            <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Title:</span>
                <span className="font-semibold text-slate-900 dark:text-white">{previewBanner.title || "None"}</span>
              </div>
              {previewBanner.subtitle && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Subtitle:</span>
                  <span className="text-slate-700 dark:text-slate-300">{previewBanner.subtitle}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">Status:</span>
                <span className="capitalize font-semibold">{previewBanner.status}</span>
              </div>
            </div>

            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setPreviewBanner(null)}>
                Close Preview
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Banner?"
        message={`Are you sure you want to delete banner "${deleteTarget?.title || "Untitled"}"? This action cannot be undone.`}
        confirmText={deleting ? "Deleting..." : "Delete Banner"}
        variant="danger"
      />
    </div>
  );
};

export default PorterBanners;
