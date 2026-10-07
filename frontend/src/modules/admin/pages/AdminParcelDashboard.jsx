import React, { useState, useEffect, useCallback, useRef } from "react";
import InvoiceDownloadButton from "@shared/components/InvoiceDownloadButton";
import PageHeader from "@shared/components/ui/PageHeader";
import { adminPorterApi } from "../services/api/porterApi";
import { createPortal } from "react-dom";
import { useSearchParams, useParams, useNavigate, useLocation } from "react-router-dom";
import {
  Truck,
  DollarSign,
  Package,
  TrendingUp,
  Settings,
  User,
  MapPin,
  ClipboardList,
  AlertCircle,
  Activity,
  CheckCircle2,
  XCircle,
  Save,
  ArrowRight,
  Building2,
  Plus,
  Pencil,
  Trash2,
  Star,
  EyeOff,
  Eye,
  Clock,
  FileSpreadsheet,
  Upload,
  Route,
} from "lucide-react";
import { toast } from "sonner";
import { parcelApi } from "../../customer/services/parcelApi";
import { zonesApi } from "@shared/services/zonesApi";
import { formatZoneLabel } from "@shared/utils/zoneGeometry";
import {
  maskName,
  maskPhone,
  maskAmount,
  checkName,
  checkPhone,
  checkAmount,
  firstError,
} from "../utils/formRules";
import {
  onParcelNew,
  onParcelStatusUpdate,
  getOrderSocket,
} from "@/core/services/orderSocket";
import { createSocketTokenReader } from "@core/utils/authStorage";
import { STORAGE_KEYS } from "@core/utils/storage";

const AdminParcelDashboard = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tab: urlTab } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const validTabs = ["all", "active", "pricing", "couriers", "cityRates", "reviews", "reports"];
  const [activeTab, setActiveTab] = useState(() => (urlTab && validTabs.includes(urlTab) ? urlTab : "all"));

  useEffect(() => {
    if (urlTab && validTabs.includes(urlTab) && urlTab !== activeTab) {
      setActiveTab(urlTab);
    }
  }, [urlTab]);

  useEffect(() => {
    if (!urlTab) {
      navigate(`/admin/parcels/all${location.search}`, { replace: true });
    }
  }, [urlTab, location.search, navigate]);

  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    navigate(`/admin/parcels/${tabId}`);
  };
  const [loading, setLoading] = useState(false);
  const [parcels, setParcels] = useState([]);
  const [riders, setRiders] = useState([]);
  const [selectedParcel, setSelectedParcel] = useState(null);
  const [selectedParcelLoading, setSelectedParcelLoading] = useState(false);
  const [pickupProofPreview, setPickupProofPreview] = useState(null);
  const [lateRefundAmount, setLateRefundAmount] = useState("");
  const [lateRefundSaving, setLateRefundSaving] = useState(false);
  const [parcelReviews, setParcelReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [couriers, setCouriers] = useState([]);
  const [addCourierForm, setAddCourierForm] = useState({
    name: "",
    phone: "",
    zoneIds: [],
    allZones: false,
    sortOrder: "0",
    isActive: true,
  });
  const [editCourierForm, setEditCourierForm] = useState({
    name: "",
    phone: "",
    zoneIds: [],
    allZones: false,
    sortOrder: "0",
    isActive: true,
  });
  const [courierSaving, setCourierSaving] = useState(false);
  const [courierEditModalOpen, setCourierEditModalOpen] = useState(false);
  const [editingCourierId, setEditingCourierId] = useState(null);
  const [editingCourierIsOther, setEditingCourierIsOther] = useState(false);
  const [courierToDelete, setCourierToDelete] = useState(null);
  const [courierDeleting, setCourierDeleting] = useState(false);
  const [zones, setZones] = useState([]);

  // Courier city-to-city rate card (Excel-uploaded)
  const [cityRates, setCityRates] = useState([]);
  const [cityRatesLoading, setCityRatesLoading] = useState(false);
  const [cityRateUploading, setCityRateUploading] = useState(false);
  const [cityRateUploadResult, setCityRateUploadResult] = useState(null);
  const [manualRateForm, setManualRateForm] = useState({
    originCity: "",
    destinationCity: "",
    // { [courierCompanyId]: "chargeString" } — one input per courier, same
    // shape as one row of the Excel sheet.
    charges: {},
  });
  const [manualRateSaving, setManualRateSaving] = useState(false);
  const [rateRowToDelete, setRateRowToDelete] = useState(null);
  const [templateDownloading, setTemplateDownloading] = useState(false);

  // Fetched once — reused for the add/edit courier zone checkboxes.
  useEffect(() => {
    zonesApi
      .getActiveZones()
      .then((res) => setZones(res.data?.results || []))
      .catch(() => {});
  }, []);

  const zoneById = useCallback(
    (zoneId) => zones.find((z) => String(z._id) === String(zoneId)) || null,
    [zones],
  );

  const courierEditScrollRef = useRef(null);
  const courierEditModalRef = useRef(null);
  const parcelDetailScrollRef = useRef(null);
  const parcelDetailModalRef = useRef(null);

  const modalOpen = Boolean(
    selectedParcel ||
    courierEditModalOpen ||
    courierToDelete,
  );

  useEffect(() => {
    if (!modalOpen) return undefined;

    const scrollY = window.scrollY;
    const {
      overflow: prevBodyOverflow,
      position: prevBodyPosition,
      top: prevBodyTop,
      width: prevBodyWidth,
    } = document.body.style;
    const prevHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.position = prevBodyPosition;
      document.body.style.top = prevBodyTop;
      document.body.style.width = prevBodyWidth;
      document.documentElement.style.overflow = prevHtmlOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [modalOpen]);

  // Touchpad/wheel: body is locked + Lenis steals events — manually scroll modal bodies.
  useEffect(() => {
    if (!selectedParcel && !courierEditModalOpen) return undefined;

    const handleWheel = (event) => {
      const parcelModal = parcelDetailModalRef.current;
      const courierModal = courierEditModalRef.current;

      let scrollEl = null;

      if (parcelModal?.contains(event.target)) {
        scrollEl = parcelDetailScrollRef.current;
      } else if (courierModal?.contains(event.target)) {
        const dialogEl = courierModal.querySelector(
          "[data-courier-edit-dialog]",
        );
        if (dialogEl && !dialogEl.contains(event.target)) {
          event.preventDefault();
          return;
        }
        scrollEl = courierEditScrollRef.current;
      } else {
        event.preventDefault();
        return;
      }

      if (!scrollEl) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const maxScroll = Math.max(
        0,
        scrollEl.scrollHeight - scrollEl.clientHeight,
      );
      scrollEl.scrollTop = Math.min(
        maxScroll,
        Math.max(0, scrollEl.scrollTop + event.deltaY),
      );
    };

    document.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });

    return () => {
      document.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [selectedParcel, courierEditModalOpen]);

  // Pricing Config state
  const [pricing, setPricing] = useState({
    fixedDeliveryCharge: 0,
    weightCharge: 0,
    maxWeightKg: 50,
    expressCharge: 0,
    deliveryRadiusKm: 5,
    riderPerKmRate: 0,
    packageCategories: [],
  });
  const [newPackageCategoryLabel, setNewPackageCategoryLabel] = useState("");
  const [newPackageCategorySegment, setNewPackageCategorySegment] =
    useState("personal");
  const [pricingSaving, setPricingSaving] = useState(false);

  // Reports state
  const [reports, setReports] = useState({
    totalDeliveries: 0,
    completed: 0,
    cancelled: 0,
    revenue: 0,
    preTaxRevenue: 0,
    gstCollected: 0,
    riderPerKmRate: 0,
    riderPayout: 0,
    adminCommission: 0,
    courierChargeCollected: 0,
  });

  const fetchParcelReviews = useCallback(async () => {
    try {
      setReviewsLoading(true);
      const res = await parcelApi.adminGetReviews({ limit: 100 });
      if (res.data?.success) {
        const payload = res.data.result || {};
        setParcelReviews(Array.isArray(payload.items) ? payload.items : []);
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load reviews");
    } finally {
      setReviewsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "reviews") {
      fetchParcelReviews();
    }
  }, [activeTab, fetchParcelReviews]);

  const handleReviewStatus = async (id, status) => {
    try {
      const res = await parcelApi.adminUpdateReviewStatus(id, { status });
      if (res.data?.success) {
        toast.success(`Review ${status}`);
        fetchParcelReviews();
      } else {
        toast.error(res.data?.message || "Failed to update review");
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to update review");
    }
  };

  const fetchRiders = useCallback(async () => {
    const res = await parcelApi.adminGetRiders();
    if (res.data?.success) {
      setRiders(res.data.results || res.data.result || []);
    }
  }, []);

  const fetchCouriers = useCallback(async () => {
    const res = await parcelApi.adminGetCouriers();
    if (res.data?.success) {
      setCouriers(res.data.results || res.data.result || []);
    }
  }, []);

  const fetchCityRates = useCallback(async () => {
    setCityRatesLoading(true);
    try {
      const [ratesRes, couriersRes] = await Promise.all([
        parcelApi.adminGetCityRates(),
        parcelApi.adminGetCouriers(),
      ]);
      if (ratesRes.data?.success) {
        setCityRates(ratesRes.data.results || ratesRes.data.result || []);
      }
      if (couriersRes.data?.success) {
        setCouriers(couriersRes.data.results || couriersRes.data.result || []);
      }
    } finally {
      setCityRatesLoading(false);
    }
  }, []);

  const fetchPricing = useCallback(async () => {
    const res = await parcelApi.adminGetPricingConfig();
    if (res.data?.success) {
      const cfg = res.data.result || {};
      setPricing({
        fixedDeliveryCharge: cfg.fixedDeliveryCharge ?? 0,
        weightCharge: cfg.weightCharge ?? 0,
        maxWeightKg: cfg.maxWeightKg ?? 50,
        expressCharge: cfg.expressCharge ?? 0,
        deliveryRadiusKm: cfg.deliveryRadiusKm ?? 5,
        riderPerKmRate: cfg.riderPerKmRate ?? 0,
        packageCategories: Array.isArray(cfg.packageCategories)
          ? cfg.packageCategories
          : [],
      });
    }
  }, []);

  const fetchReports = useCallback(async () => {
    const res = await parcelApi.adminGetReports();
    if (res.data?.success) {
      setReports({
        totalDeliveries: 0,
        completed: 0,
        cancelled: 0,
        revenue: 0,
        riderPerKmRate: 0,
        riderPayout: 0,
        adminCommission: 0,
        ...(res.data.result || {}),
      });
    }
  }, []);

  /**
   * Only fetches parcels every poll — that's the one thing every tab's deep
   * link (?parcelId=) and the "all"/"active" tabs need live. Riders, couriers,
   * pricing and reports are each fetched once when their own tab becomes
   * active (see the effect below), not on every 15s tick — nobody sitting on
   * the pricing tab needs the rider/courier/reports endpoints re-hit in the
   * background, and the pricing form must never be silently overwritten
   * mid-edit anyway.
   */
  const fetchData = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const parcelsRes = await parcelApi.adminGetParcels();
      if (parcelsRes.data?.success) {
        setParcels(parcelsRes.data.results || parcelsRes.data.result || []);
      }
    } catch (error) {
      console.error("Failed to load dashboard data:", error);
      if (!isSilent) toast.error("Failed to load dashboard data");
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, []);

  // Read inside the interval below without resetting it on every tab switch.
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    fetchData(false);

    // 15-second background polling — only while looking at a tab that shows
    // the parcel list (socket events already keep it in sync in real time;
    // this is just a consistency backstop). Sitting on Pricing/Couriers/
    // Reviews/Reports has no reason to keep hitting /parcel/admin/all.
    const pollInterval = setInterval(() => {
      if (activeTabRef.current === "all" || activeTabRef.current === "active") {
        fetchData(true);
      }
    }, 15000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [fetchData]);

  // Fetch each tab's own data once when it becomes active — not on every poll.
  useEffect(() => {
    if (activeTab === "active") fetchRiders();
    else if (activeTab === "couriers") fetchCouriers();
    else if (activeTab === "cityRates") fetchCityRates();
    else if (activeTab === "pricing") fetchPricing();
    else if (activeTab === "reports") fetchReports();
  }, [activeTab, fetchRiders, fetchCouriers, fetchCityRates, fetchPricing, fetchReports]);

  // Listen to real-time parcel bookings via socket
  useEffect(() => {
    const getToken = createSocketTokenReader(STORAGE_KEYS.AUTH_ADMIN);
    const unsubscribe = onParcelNew(getToken, (newParcel) => {
      console.log("[AdminParcelDashboard] Real-time new courier:", newParcel);

      // Update parcels state: prepend newParcel if not already present
      setParcels((prev) => {
        if (prev.some((p) => p._id === newParcel._id)) return prev;
        return [newParcel, ...prev];
      });

      // Update reports count
      setReports((prev) => ({
        ...prev,
        totalDeliveries: (prev.totalDeliveries || 0) + 1,
      }));

      toast.info(`New courier request #${String(newParcel._id).slice(-6)}`);
      setSelectedParcel(newParcel);

      // Immediately fetch fully populated data in background
      fetchData(true);
    });

    return () => {
      unsubscribe();
    };
  }, [fetchData]);

  const openParcelDetail = useCallback(async (parcel) => {
    if (!parcel?._id) return;
    setSelectedParcel(parcel);
    setSelectedParcelLoading(true);
    try {
      const res = await parcelApi.adminGetParcel(parcel._id);
      if (res.data?.success && res.data.result) {
        setSelectedParcel(res.data.result);
      }
    } catch (error) {
      console.error("Failed to refresh courier detail:", error);
    } finally {
      setSelectedParcelLoading(false);
    }
  }, []);

  // Keep open modal in sync when list refreshes (proofs appear after rider upload).
  useEffect(() => {
    if (!selectedParcel?._id || !parcels.length) return;
    const fresh = parcels.find(
      (p) => String(p._id) === String(selectedParcel._id),
    );
    if (!fresh) return;
    const samePickup =
      fresh.pickupProofImage === selectedParcel.pickupProofImage;
    const sameDrop =
      fresh.deliveryProofImage === selectedParcel.deliveryProofImage;
    const sameStatus = fresh.status === selectedParcel.status;
    if (samePickup && sameDrop && sameStatus) return;
    setSelectedParcel((prev) => ({ ...prev, ...fresh }));
  }, [
    parcels,
    selectedParcel?._id,
    selectedParcel?.pickupProofImage,
    selectedParcel?.deliveryProofImage,
    selectedParcel?.status,
  ]);

  // Open parcel details when navigated from notification / alert (`?parcelId=`)
  useEffect(() => {
    const parcelId = searchParams.get("parcelId");
    if (!parcelId || !parcels.length) return;
    const match = parcels.find((p) => String(p._id) === String(parcelId));
    if (!match) return;
    openParcelDetail(match);
    handleTabChange("all");
    const next = new URLSearchParams(searchParams);
    next.delete("parcelId");
    setSearchParams(next, { replace: true });
  }, [parcels, searchParams, setSearchParams, openParcelDetail]);

  // Live status updates (assigned rider / progress / delivered)
  useEffect(() => {
    const getToken = createSocketTokenReader(STORAGE_KEYS.AUTH_ADMIN);
    getOrderSocket(getToken);
    return onParcelStatusUpdate(getToken, (payload) => {
      const updated = payload?.parcel || payload;
      const id = updated?._id || payload?.parcelId;
      if (!id) return;

      setParcels((prev) => {
        const exists = prev.some((p) => String(p._id) === String(id));
        if (!exists) return prev;
        return prev.map((p) =>
          String(p._id) === String(id) ? { ...p, ...updated } : p,
        );
      });

      setSelectedParcel((prev) =>
        prev && String(prev._id) === String(id)
          ? { ...prev, ...updated }
          : prev,
      );
      // No re-fetch here — the socket payload already carries the updated
      // parcel, and this event fires on every status change of every active
      // job platform-wide, so re-hitting /parcel/admin/all on each one was
      // the main source of the repeated network calls.
    });
  }, []);

  // Handle pricing update
  const handleUpdatePricing = async (e) => {
    e.preventDefault();
    setPricingSaving(true);
    try {
      const payload = {
        fixedDeliveryCharge: Number(pricing.fixedDeliveryCharge) || 0,
        weightCharge: Number(pricing.weightCharge) || 0,
        maxWeightKg: Number(pricing.maxWeightKg),
        expressCharge: Number(pricing.expressCharge) || 0,
        deliveryRadiusKm: Number(pricing.deliveryRadiusKm) || 5,
        riderPerKmRate: Number(pricing.riderPerKmRate) || 0,
        packageCategories: pricing.packageCategories,
      };
      const res = await parcelApi.adminUpdatePricingConfig(payload);
      if (res.data && res.data.success) {
        const cfg = res.data.result || {};
        setPricing((prev) => ({
          ...prev,
          fixedDeliveryCharge: cfg.fixedDeliveryCharge ?? prev.fixedDeliveryCharge,
          weightCharge: cfg.weightCharge ?? prev.weightCharge,
          maxWeightKg: cfg.maxWeightKg ?? prev.maxWeightKg,
          expressCharge: cfg.expressCharge ?? prev.expressCharge,
          deliveryRadiusKm: cfg.deliveryRadiusKm ?? prev.deliveryRadiusKm,
          riderPerKmRate: cfg.riderPerKmRate ?? prev.riderPerKmRate,
          packageCategories: Array.isArray(cfg.packageCategories)
            ? cfg.packageCategories
            : prev.packageCategories,
        }));
        toast.success("Courier settings saved");
      } else {
        toast.error(res.data?.message || "Failed to update settings");
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to save settings");
    } finally {
      setPricingSaving(false);
    }
  };

  const emptyCourierForm = {
    name: "",
    phone: "",
    zoneIds: [],
    allZones: false,
    sortOrder: "0",
    isActive: true,
  };

  const closeCourierEditModal = () => {
    setCourierEditModalOpen(false);
    setEditingCourierId(null);
    setEditingCourierIsOther(false);
    setEditCourierForm(emptyCourierForm);
  };

  const startEditCourier = (company) => {
    setEditingCourierId(company._id);
    setEditingCourierIsOther(company.isOther === true);
    setEditCourierForm({
      name: company.name || "",
      phone: company.phone || "",
      zoneIds: Array.isArray(company.zoneIds)
        ? company.zoneIds.map((z) => String(z?._id || z))
        : [],
      allZones: company.allZones === true,
      sortOrder: String(company.sortOrder ?? 0),
      isActive: company.isActive !== false,
    });
    setCourierEditModalOpen(true);
  };

  const buildCourierApiPayload = (form) => ({
    name: String(form.name || "").trim(),
    phone: String(form.phone || "").replace(/\D/g, "").slice(-10),
    zoneIds: form.allZones ? [] : form.zoneIds || [],
    allZones: form.allZones === true,
    sortOrder: Number(form.sortOrder) || 0,
    isActive: form.isActive !== false,
  });

  /** Name, phone and sort order. */
  const validateCourierFields = (form) =>
    firstError(
      checkName(form.name, "Courier company name"),
      checkPhone(form.phone, "Contact phone", { required: true }),
      checkAmount(form.sortOrder, "Sort order", { max: 9999 }),
    );

  const handleAddCourier = async (e) => {
    e.preventDefault();
    const invalid = validateCourierFields(addCourierForm);
    if (invalid) return toast.error(invalid);

    setCourierSaving(true);
    try {
      const payload = buildCourierApiPayload(addCourierForm);
      const res = await parcelApi.adminCreateCourier(payload);
      if (res.data?.success) {
        toast.success("Courier company added");
        setAddCourierForm(emptyCourierForm);
        fetchCouriers();
      } else {
        toast.error(res.data?.message || "Failed to save courier company");
      }
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to save courier company",
      );
    } finally {
      setCourierSaving(false);
    }
  };

  const handleUpdateCourier = async (e) => {
    e.preventDefault();
    if (!editingCourierId) return;

    const invalid = editingCourierIsOther
      ? null
      : validateCourierFields(editCourierForm);
    if (invalid) return toast.error(invalid);

    setCourierSaving(true);
    try {
      const payload = buildCourierApiPayload(editCourierForm);
      const res = await parcelApi.adminUpdateCourier(editingCourierId, payload);
      if (res.data?.success) {
        toast.success("Courier company updated");
        closeCourierEditModal();
        fetchCouriers();
      } else {
        toast.error(res.data?.message || "Failed to update courier company");
      }
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to update courier company",
      );
    } finally {
      setCourierSaving(false);
    }
  };

  const confirmDeleteCourier = async () => {
    const courierId = String(
      courierToDelete?._id || courierToDelete?.id || "",
    ).trim();
    if (!courierId) {
      toast.error("Could not delete: courier id missing");
      return;
    }

    setCourierDeleting(true);
    try {
      const res = await parcelApi.adminDeleteCourier(courierId);
      if (res.data?.success) {
        toast.success("Courier company deleted");
        setCouriers((prev) =>
          prev.filter((c) => String(c._id || c.id) !== courierId),
        );
        if (String(editingCourierId) === courierId) closeCourierEditModal();
        setCourierToDelete(null);
      } else {
        toast.error(res.data?.message || "Failed to delete");
      }
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to delete courier company",
      );
    } finally {
      setCourierDeleting(false);
    }
  };

  const handleToggleCourierActive = async (company) => {
    try {
      const res = await parcelApi.adminUpdateCourier(company._id, {
        isActive: !company.isActive,
      });
      if (res.data?.success) {
        toast.success(
          company.isActive ? "Courier deactivated" : "Courier activated",
        );
        fetchCouriers();
      } else {
        toast.error(res.data?.message || "Failed to update status");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to update status");
    }
  };

  const handleUploadCityRates = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;

    setCityRateUploading(true);
    setCityRateUploadResult(null);
    try {
      const res = await parcelApi.adminUploadCityRates(file);
      if (res.data?.success) {
        const result = res.data.result || {};
        setCityRateUploadResult(result);
        toast.success(`Uploaded — ${result.ratesUpserted || 0} rates saved`);
        fetchCityRates();
      } else {
        toast.error(res.data?.message || "Failed to upload rate card");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to upload rate card");
    } finally {
      setCityRateUploading(false);
    }
  };

  const handleManualRateSubmit = async (e) => {
    e.preventDefault();
    const originCity = manualRateForm.originCity.trim();
    const destinationCity = manualRateForm.destinationCity.trim();
    if (!originCity || !destinationCity) {
      return toast.error("Enter both origin and destination city");
    }

    // One entry per courier that has a value filled in — same shape as one
    // row of the Excel sheet, so a partial fill only touches those couriers.
    const rates = Object.entries(manualRateForm.charges)
      .filter(([, value]) => String(value ?? "").trim() !== "")
      .map(([courierCompanyId, value]) => ({
        courierCompanyId,
        charge: Number(value),
      }));

    if (!rates.length) {
      return toast.error("Enter a charge for at least one courier");
    }
    if (rates.some((r) => !Number.isFinite(r.charge) || r.charge < 0)) {
      return toast.error("Enter valid charge amounts");
    }

    setManualRateSaving(true);
    try {
      const res = await parcelApi.adminUpsertCityRate({
        originCity,
        destinationCity,
        rates,
      });
      if (res.data?.success) {
        toast.success(`Saved ${rates.length} courier rate(s) for this route`);
        setManualRateForm({ originCity: "", destinationCity: "", charges: {} });
        fetchCityRates();
      } else {
        toast.error(res.data?.message || "Failed to save rates");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to save rates");
    } finally {
      setManualRateSaving(false);
    }
  };

  const handleDownloadCityRateTemplate = async () => {
    setTemplateDownloading(true);
    try {
      const res = await parcelApi.adminDownloadCityRateTemplate();
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.download = "courier-city-rate-template.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(
        error.response?.data?.message || "Failed to download template",
      );
    } finally {
      setTemplateDownloading(false);
    }
  };

  const confirmDeleteCityRate = async () => {
    if (!rateRowToDelete?._id) return;
    try {
      const res = await parcelApi.adminDeleteCityRate(rateRowToDelete._id);
      if (res.data?.success) {
        toast.success("Rate removed");
        setCityRates((prev) => prev.filter((r) => r._id !== rateRowToDelete._id));
      } else {
        toast.error(res.data?.message || "Failed to remove rate");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to remove rate");
    } finally {
      setRateRowToDelete(null);
    }
  };

  // Groups the flat rate list into one row per (origin, destination) with
  // each courier's charge as a column — matches how the Excel sheet reads.
  const groupedCityRates = (() => {
    const byRoute = new Map();
    for (const rate of cityRates) {
      const key = `${rate.originCity}__${rate.destinationCity}`;
      if (!byRoute.has(key)) {
        byRoute.set(key, {
          originCity: rate.originCity,
          destinationCity: rate.destinationCity,
          rates: [],
        });
      }
      byRoute.get(key).rates.push(rate);
    }
    return Array.from(byRoute.values());
  })();

  const getActiveParcels = () => {
    const activeStatuses = [
      "SEARCHING",
      "REQUESTED",
      "ACCEPTED",
      "RIDER_ASSIGNED",
      "PICKUP_REACHED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
    ];
    return parcels.filter((p) => activeStatuses.includes(p.status));
  };

  const getSearchingParcels = () =>
    parcels.filter((p) => p.status === "SEARCHING" && !p.deliveryPartnerId);

  const formatParcelStatus = (status) => {
    if (status === "SEARCHING") return "Searching for rider";
    return status;
  };

  return (
    <div className="p-6 font-outfit max-w-6xl mx-auto space-y-6">
      {/* Page Title */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-100 pb-5">
        <PageHeader
          className="p-0"
          icon={Truck}
          title="Courier Delivery Panel"
          description="Manage courier delivery bookings, configure global rates, assign riders, and monitor operations."
        />

        {/* Tab Controls */}
        <div className="flex flex-wrap bg-slate-100 p-1 rounded-xl gap-0.5">
          {[
            { id: "all", label: "All Bookings", icon: ClipboardList },
            { id: "active", label: "Active Deliveries", icon: Activity },
            { id: "pricing", label: "Courier Settings", icon: Settings },
            { id: "couriers", label: "Couriers", icon: Building2 },
            { id: "cityRates", label: "City Rates", icon: Route },
            { id: "reviews", label: "Reviews", icon: Star },
            { id: "reports", label: "Revenue Reports", icon: TrendingUp },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg font-bold text-xs transition-all ${
                activeTab === tab.id
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}>
              <tab.icon size={14} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <span className="text-slate-400 animate-pulse font-medium">
            Loading panel data...
          </span>
        </div>
      ) : (
        <>
          {/* TAB 1: ALL BOOKINGS */}
          {activeTab === "all" && (
            <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
              <div className="p-5 border-b border-slate-100 flex justify-between items-center">
                <h2 className="text-base font-black text-slate-800">
                  All Requests History
                </h2>
                <span className="text-xs bg-slate-100 px-3 py-1 rounded-full font-bold text-slate-600">
                  {parcels.length} total requests
                </span>
              </div>

              {parcels.length === 0 ? (
                <div className="p-12 text-center text-slate-400">
                  No courier bookings registered in the system yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-slate-400 font-bold text-xs uppercase tracking-wider border-b border-slate-100">
                        <th className="p-4">ID / Date</th>
                        <th className="p-4">Customer Details</th>
                        <th className="p-4">Pickup Address</th>
                        <th className="p-4">Dropoff Address</th>
                        <th className="p-4">Fare & Weight</th>
                        <th className="p-4">Status / Rider</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {parcels.map((parcel) => (
                        <tr
                          key={parcel._id}
                          className="hover:bg-slate-50/50 cursor-pointer transition-colors"
                          onClick={() => openParcelDetail(parcel)}>
                          <td className="p-4 align-top">
                            <span className="font-bold text-slate-800">
                              #{parcel._id.slice(-6)}
                            </span>
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              {new Date(parcel.createdAt).toLocaleDateString()}
                            </div>
                            {parcel.lateRefundRequest?.status ===
                              "requested" && (
                              <span className="inline-flex mt-1 text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                                Late refund
                                {parcel.lateRefundRequest?.lateByLabel ||
                                parcel.pickupSla?.lateByLabel
                                  ? ` · ${
                                      parcel.lateRefundRequest?.lateByLabel ||
                                      parcel.pickupSla?.lateByLabel
                                    }`
                                  : ""}
                              </span>
                            )}
                          </td>
                          <td className="p-4 align-top">
                            <span className="font-bold text-slate-800 block">
                              {parcel.customerId?.name || "Customer"}
                            </span>
                            <span className="text-xs text-slate-400">
                              {parcel.customerId?.phone || "N/A"}
                            </span>
                          </td>
                          <td className="p-4 align-top max-w-[200px]">
                            <span className="font-bold text-slate-700 block">
                              {parcel.pickupAddress?.name} (
                              {parcel.pickupAddress?.phone})
                            </span>
                            <span className="text-xs text-slate-400 line-clamp-2 mt-0.5">
                              {parcel.pickupAddress?.fullAddress}
                            </span>
                          </td>
                          <td className="p-4 align-top max-w-[200px]">
                            <span className="font-bold text-slate-700 block">
                              {parcel.dropAddress?.name} (
                              {parcel.dropAddress?.phone})
                            </span>
                            <span className="text-xs text-slate-400 line-clamp-2 mt-0.5">
                              {parcel.dropAddress?.fullAddress}
                            </span>
                          </td>
                          <td className="p-4 align-top">
                            <span className="font-black text-slate-900 block">
                              ₹{parcel.fare}
                            </span>
                            <span className="text-xs text-slate-400">
                              {parcel.weight} KG
                            </span>
                            <span
                              className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full mt-1 inline-block ${
                                parcel.deliverySpeed === "express"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-slate-100 text-slate-500"
                              }`}>
                              {parcel.deliverySpeed === "express"
                                ? "Express · 10 min"
                                : "Normal · 30 min"}
                            </span>
                            {String(parcel.paymentMethod).toUpperCase() ===
                              "COD" && (
                              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full mt-1 inline-block bg-orange-50 text-orange-700 block w-fit">
                                COD ·{" "}
                                {parcel.codSettlement?.status ===
                                  "REMITTED_TO_ADMIN" ||
                                parcel.paymentStatus === "PAID"
                                  ? "Admin paid"
                                  : parcel.codSettlement?.status ===
                                      "WITH_SELLER"
                                    ? "With seller"
                                    : parcel.codSettlement?.status ===
                                        "RIDER_HOLDING"
                                      ? "With rider"
                                      : "Collect pending"}
                              </span>
                            )}
                          </td>
                          <td className="p-4 align-top">
                            <span
                              className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full uppercase block w-fit ${
                                parcel.status === "DELIVERED"
                                  ? "bg-green-100 text-green-700"
                                  : parcel.status === "CANCELLED"
                                    ? "bg-red-100 text-red-600"
                                    : parcel.status === "SEARCHING"
                                      ? "bg-amber-100 text-amber-700 animate-pulse"
                                      : "bg-orange-100 text-orange-700 animate-pulse"
                              }`}>
                              {formatParcelStatus(parcel.status)}
                            </span>

                            {parcel.deliveryPartnerId ? (
                              <div className="text-xs text-slate-500 font-medium mt-1">
                                Rider: {parcel.deliveryPartnerId.name}
                              </div>
                            ) : (
                              parcel.status !== "CANCELLED" &&
                              parcel.status !== "DELIVERED" && (
                                <div className="text-[11px] text-amber-700 font-bold mt-1">
                                  Auto broadcasting to nearby courier riders
                                </div>
                              )
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: ACTIVE DELIVERIES */}
          {activeTab === "active" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Active list */}
              <div className="md:col-span-2 bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-5 border-b border-slate-100 flex justify-between items-center">
                  <h2 className="text-base font-black text-slate-800">
                    In-Progress Deliveries
                  </h2>
                  <div className="flex items-center gap-2">
                    {getSearchingParcels().length > 0 && (
                      <span className="text-xs bg-amber-50 text-amber-700 px-3 py-1 rounded-full font-bold">
                        {getSearchingParcels().length} searching
                      </span>
                    )}
                    <span className="text-xs bg-orange-50 text-orange-600 px-3 py-1 rounded-full font-bold">
                      {getActiveParcels().length} active
                    </span>
                  </div>
                </div>

                {getActiveParcels().length === 0 ? (
                  <div className="p-12 text-center text-slate-400">
                    No active courier deliveries currently.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {getActiveParcels().map((parcel) => (
                      <div
                        key={parcel._id}
                        className="p-5 hover:bg-slate-50/50 flex flex-col md:flex-row justify-between gap-4 cursor-pointer transition-colors"
                        onClick={() => openParcelDetail(parcel)}>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-800">
                              #{parcel._id.slice(-6)}
                            </span>
                            <span className="text-xs text-slate-400">
                              {new Date(parcel.createdAt).toLocaleTimeString()}
                            </span>
                            <span className="text-[10px] font-extrabold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full uppercase">
                              {formatParcelStatus(parcel.status)}
                            </span>
                          </div>

                          <div className="text-xs text-slate-500 font-medium space-y-1">
                            <div>
                              <strong className="text-slate-700">From:</strong>{" "}
                              {parcel.pickupAddress.fullAddress}
                            </div>
                            <div>
                              <strong className="text-slate-700">To:</strong>{" "}
                              {parcel.dropAddress.fullAddress}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col justify-between items-end shrink-0">
                          <span className="font-black text-slate-900">
                            ₹{parcel.fare}
                          </span>
                          {parcel.deliveryPartnerId ? (
                            <div className="text-xs bg-slate-50 px-3 py-1 rounded-lg border border-slate-200 mt-2">
                              Rider:{" "}
                              <strong className="text-slate-700">
                                {parcel.deliveryPartnerId.name}
                              </strong>
                            </div>
                          ) : (
                            <div className="text-[11px] text-amber-700 font-bold mt-2">
                              Request is auto-broadcasting
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Verified riders info sidebar */}
              <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-sm space-y-4">
                <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                  <User className="text-primary" size={18} /> Verified Riders
                  list
                </h2>
                <div className="divide-y divide-slate-100 max-h-[400px] overflow-y-auto pr-1">
                  {riders.map((rider) => {
                    const statusConfig = !rider.isParcelService
                      ? {
                          text: "No Courier Service",
                          style: "bg-red-50 text-red-700",
                        }
                      : !rider.isOnline
                        ? {
                            text: "Offline",
                            style: "bg-slate-100 text-slate-500",
                          }
                        : rider.isBusy
                          ? {
                              text: "Busy",
                              style: "bg-amber-50 text-amber-700",
                            }
                          : {
                              text: "Available",
                              style: "bg-green-50 text-green-700",
                            };

                    return (
                      <div
                        key={rider._id}
                        className="py-3 flex justify-between items-center text-xs">
                        <div>
                          <span className="font-bold text-slate-800 block">
                            {rider.name}
                          </span>
                          <span className="text-slate-400">{rider.phone}</span>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full font-bold uppercase text-[9px] ${statusConfig.style}`}>
                          {statusConfig.text}
                        </span>
                      </div>
                    );
                  })}
                  {riders.length === 0 && (
                    <p className="text-slate-400 text-xs py-4 text-center">
                      No verified delivery partners.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: PARCEL SETTINGS */}
          {activeTab === "pricing" && (
            <div className="max-w-2xl mx-auto space-y-5">
              <form onSubmit={handleUpdatePricing} className="space-y-5">
                <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <DollarSign className="text-primary" size={18} /> Delivery
                      Charge
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Flat fee plus a per-kg weight charge — the customer pays
                      the sum of both regardless of distance.
                    </p>
                  </div>

                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Delivery Charge (₹, fixed)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={pricing.fixedDeliveryCharge}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            fixedDeliveryCharge: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Charged to every customer booking, no matter the
                        distance involved.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Weight Charge (₹ / kg)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={pricing.weightCharge}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            weightCharge: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Multiplied by the package weight the customer enters
                        and added on top of the delivery charge. 0 = no
                        weight charge.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Max Weight (kg)
                      </label>
                      <input
                        type="number"
                        min="0.1"
                        max="1000"
                        step="0.1"
                        required
                        value={pricing.maxWeightKg}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            maxWeightKg: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Heaviest package a customer can book. Weights
                        above this are rejected on the booking form.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Express Charge (₹)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={pricing.expressCharge}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            expressCharge: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Added to the fare when a customer books Express.
                        Shown as its own line to the customer, the rider and
                        on the invoice. 0 = Express costs nothing extra.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <MapPin className="text-primary" size={18} /> Delivery
                      Partner Search Radius
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Decide how far nearby courier riders are notified when a
                      booking starts.
                    </p>
                  </div>

                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Delivery Radius (KM)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="0.5"
                        required
                        value={pricing.deliveryRadiusKm}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            deliveryRadiusKm: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Hard radius — only delivery boys within this many km of
                        the customer's pickup location will see the booking
                        request. The radius does not auto-expand.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <Package className="text-primary" size={18} /> Package
                      Categories
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Add categories under Personal or Business. Customers pick
                      a segment first, then see only the categories for that
                      segment.
                    </p>
                  </div>

                  <div className="p-5 space-y-4">
                    <div className="space-y-2">
                      {(pricing.packageCategories || []).length === 0 && (
                        <p className="text-xs text-slate-400">
                          No categories yet. Add one below.
                        </p>
                      )}
                      {(pricing.packageCategories || []).map((cat, idx) => (
                        <div
                          key={`${cat.value}-${idx}`}
                          className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                          <input
                            type="text"
                            value={cat.label}
                            onChange={(e) => {
                              const label = e.target.value;
                              setPricing((p) => {
                                const next = [...(p.packageCategories || [])];
                                next[idx] = {
                                  ...next[idx],
                                  label,
                                  value:
                                    next[idx].value ||
                                    `${next[idx].segment || "personal"}_${label
                                      .toLowerCase()
                                      .replace(/[^a-z0-9]+/g, "_")
                                      .replace(/^_+|_+$/g, "")}`,
                                };
                                return { ...p, packageCategories: next };
                              });
                            }}
                            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                            placeholder="Label (e.g. Gift)"
                          />
                          <select
                            value={
                              cat.segment === "business"
                                ? "business"
                                : "personal"
                            }
                            onChange={(e) => {
                              const segment = e.target.value;
                              setPricing((p) => {
                                const next = [...(p.packageCategories || [])];
                                next[idx] = { ...next[idx], segment };
                                return { ...p, packageCategories: next };
                              });
                            }}
                            className="w-full sm:w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary bg-white">
                            <option value="personal">Personal</option>
                            <option value="business">Business</option>
                          </select>
                          <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-600 px-2">
                            <input
                              type="checkbox"
                              checked={cat.isActive !== false}
                              onChange={(e) => {
                                setPricing((p) => {
                                  const next = [...(p.packageCategories || [])];
                                  next[idx] = {
                                    ...next[idx],
                                    isActive: e.target.checked,
                                  };
                                  return { ...p, packageCategories: next };
                                });
                              }}
                            />
                            Active
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setPricing((p) => ({
                                ...p,
                                packageCategories: (
                                  p.packageCategories || []
                                ).filter((_, i) => i !== idx),
                              }))
                            }
                            className="px-3 py-2 rounded-xl bg-rose-50 text-rose-600 text-xs font-bold">
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      <input
                        type="text"
                        value={newPackageCategoryLabel}
                        onChange={(e) =>
                          setNewPackageCategoryLabel(e.target.value)
                        }
                        placeholder="Add category label"
                        className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <select
                        value={newPackageCategorySegment}
                        onChange={(e) =>
                          setNewPackageCategorySegment(e.target.value)
                        }
                        className="w-full sm:w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary bg-white">
                        <option value="personal">Personal</option>
                        <option value="business">Business</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const label = newPackageCategoryLabel.trim();
                          if (!label) return;
                          const segment =
                            newPackageCategorySegment === "business"
                              ? "business"
                              : "personal";
                          const value = `${segment}_${label
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, "_")
                            .replace(/^_+|_+$/g, "")}`;
                          setPricing((p) => ({
                            ...p,
                            packageCategories: [
                              ...(p.packageCategories || []),
                              { value, label, segment, isActive: true },
                            ],
                          }));
                          setNewPackageCategoryLabel("");
                        }}
                        className="px-4 py-2 rounded-xl bg-[color:var(--primary)] text-white text-xs font-bold">
                        Add category
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <Truck className="text-primary" size={18} /> Rider Per
                      KM Rate
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      The rider is paid this rate multiplied by the distance
                      from where they accepted the job to the customer's
                      pickup point.
                    </p>
                  </div>

                  <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Per KM Rate (₹)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={pricing.riderPerKmRate}
                        onChange={(e) =>
                          setPricing((p) => ({
                            ...p,
                            riderPerKmRate: e.target.value,
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <p className="text-[10px] text-slate-400 font-medium">
                        Rider payout = this rate × distance from accept point
                        to pickup point.
                      </p>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={pricingSaving}
                  className="w-full bg-[color:var(--primary)] hover:opacity-90 disabled:opacity-50 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all">
                  <Save size={16} />
                  {pricingSaving ? "Saving..." : "Save courier settings"}
                </button>
              </form>
            </div>
          )}

          {/* TAB: COURIER COMPANIES CRUD */}
          {activeTab === "couriers" && (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2">
                <form
                  onSubmit={handleAddCourier}
                  className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <Plus className="text-primary" size={18} />
                      Add Courier Company
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Riders drop couriers with this courier after pickup. No
                      office address needed — just name, contact and the zones
                      it serves.
                    </p>
                  </div>

                  <div className="p-5 space-y-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Company Name
                      </label>
                      <input
                        type="text"
                        required
                        value={addCourierForm.name}
                        onChange={(e) =>
                          setAddCourierForm((f) => ({
                            ...f,
                            name: maskName(e.target.value, 80),
                          }))
                        }
                        placeholder="e.g. Blue Dart"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        inputMode="numeric"
                        required
                        value={addCourierForm.phone}
                        onChange={(e) =>
                          setAddCourierForm((f) => ({
                            ...f,
                            phone: maskPhone(e.target.value),
                          }))
                        }
                        placeholder="10-digit number"
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Zones
                      </label>
                      <div className="rounded-xl border border-slate-200 p-3 space-y-2 max-h-56 overflow-y-auto">
                        <label className="flex items-center gap-2 text-xs font-bold text-primary cursor-pointer pb-2 border-b border-slate-100">
                          <input
                            type="checkbox"
                            checked={addCourierForm.allZones}
                            onChange={(e) =>
                              setAddCourierForm((f) => ({
                                ...f,
                                allZones: e.target.checked,
                                zoneIds: e.target.checked ? [] : f.zoneIds,
                              }))
                            }
                            className="accent-primary h-4 w-4"
                          />
                          All Zones (Global — every zone)
                        </label>
                        {zones.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            No active zones configured yet.
                          </p>
                        ) : (
                          zones.map((zone) => (
                            <label
                              key={zone._id}
                              className={`flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer ${
                                addCourierForm.allZones
                                  ? "opacity-40 pointer-events-none"
                                  : ""
                              }`}>
                              <input
                                type="checkbox"
                                disabled={addCourierForm.allZones}
                                checked={addCourierForm.zoneIds.includes(
                                  String(zone._id),
                                )}
                                onChange={(e) =>
                                  setAddCourierForm((f) => ({
                                    ...f,
                                    zoneIds: e.target.checked
                                      ? [...f.zoneIds, String(zone._id)]
                                      : f.zoneIds.filter(
                                          (id) => id !== String(zone._id),
                                        ),
                                  }))
                                }
                                className="accent-primary h-4 w-4"
                              />
                              {formatZoneLabel(zone.name, zone.city)}
                            </label>
                          ))
                        )}
                      </div>
                      <p className="text-[10px] text-slate-400 font-medium">
                        Zones this courier serves. Customers picking up from
                        inside a zone will see this courier as an option.
                      </p>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 uppercase">
                        Sort Order
                      </label>
                      <input
                        type="number"
                        step="1"
                        value={addCourierForm.sortOrder}
                        onChange={(e) =>
                          setAddCourierForm((f) => ({
                            ...f,
                            sortOrder: maskAmount(e.target.value, { decimals: 0, max: 4 }),
                          }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={addCourierForm.isActive}
                        onChange={(e) =>
                          setAddCourierForm((f) => ({
                            ...f,
                            isActive: e.target.checked,
                          }))
                        }
                        className="accent-primary h-4 w-4"
                      />
                      Active (shown on customer booking form)
                    </label>

                    <button
                      type="submit"
                      disabled={courierSaving}
                      className="w-full bg-[color:var(--primary)] hover:opacity-90 disabled:opacity-50 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all">
                      <Save size={16} />
                      {courierSaving ? "Saving..." : "Add Courier"}
                    </button>
                  </div>
                </form>
              </div>

              <div className="lg:col-span-3 bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-5 border-b border-slate-100 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <Building2 className="text-primary" size={18} /> Courier
                      Companies
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      {couriers.length} companies · edit & delete open in modal
                    </p>
                  </div>
                </div>

                <div className="divide-y divide-slate-100">
                  {couriers.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-10 font-medium">
                      No courier companies yet. Add one on the left.
                    </p>
                  ) : (
                    couriers.map((company) => (
                      <div
                        key={company._id}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/60">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-black text-slate-800">
                              {company.isOther
                                ? "Other (custom)"
                                : company.name}
                            </span>
                            <span
                              className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                company.isActive
                                  ? "bg-green-50 text-green-700"
                                  : "bg-slate-100 text-slate-500"
                              }`}>
                              {company.isActive ? "Active" : "Inactive"}
                            </span>
                            {company.isOther && (
                              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                Customer types name
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 font-medium mt-1">
                            {company.phone ? (
                              <>
                                <span className="font-black text-slate-800">
                                  {company.phone}
                                </span>
                                {" · "}
                              </>
                            ) : null}
                            Sort: {company.sortOrder ?? 0}
                          </p>
                          {company.isOther ? (
                            <p className="text-[11px] text-slate-500 mt-1">
                              Shown to customers as “Other”. They type their own
                              courier company name.
                            </p>
                          ) : company.allZones ? (
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                All Zones (Global)
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {(Array.isArray(company.zoneIds)
                                ? company.zoneIds
                                : []
                              ).length === 0 ? (
                                <span className="text-[11px] text-amber-600 font-semibold">
                                  No zones assigned — edit to add zones
                                </span>
                              ) : (
                                company.zoneIds.map((z) => {
                                  const id = String(z?._id || z);
                                  const zone = z?.name ? z : zoneById(id);
                                  return (
                                    <span
                                      key={id}
                                      className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                      {zone
                                        ? formatZoneLabel(zone.name, zone.city)
                                        : "Unknown zone"}
                                    </span>
                                  );
                                })
                              )}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleToggleCourierActive(company)}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 text-slate-600 hover:bg-white">
                            {company.isActive ? "Deactivate" : "Activate"}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditCourier(company)}
                            className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-primary hover:border-primary/30"
                            title="Edit">
                            <Pencil size={14} />
                          </button>
                          {!company.isOther && (
                            <button
                              type="button"
                              onClick={() => setCourierToDelete(company)}
                              className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-red-600 hover:border-red-200"
                              title="Delete">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB: COURIER CITY-TO-CITY RATE CARD */}
          {activeTab === "cityRates" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <FileSpreadsheet className="text-primary" size={18} />
                      Upload Rate Card (Excel)
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      One row per city-to-city route. Columns:{" "}
                      <span className="font-bold text-slate-600">
                        Origin City, Destination City
                      </span>
                      , then one column per courier — the column header must
                      exactly match a courier company's name below (
                      {couriers.length
                        ? couriers.map((c) => c.name).join(", ")
                        : "add couriers first"}
                      ). Leave a cell blank if that courier doesn't serve that
                      route.
                    </p>
                  </div>
                  <div className="p-5 space-y-3">
                    <button
                      type="button"
                      onClick={handleDownloadCityRateTemplate}
                      disabled={templateDownloading}
                      className="w-full flex items-center justify-center gap-2 rounded-xl border border-primary/30 text-primary text-sm font-bold py-2.5 hover:bg-primary/5 disabled:opacity-50">
                      <FileSpreadsheet size={16} />
                      {templateDownloading
                        ? "Preparing..."
                        : "Download Excel Template"}
                    </button>
                    <p className="text-[10px] text-slate-400 font-medium">
                      Ready-made file with a column for each of your courier
                      companies already set up — fill in the rows and upload
                      it back below.
                    </p>
                    <label className="flex items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-2xl py-8 cursor-pointer hover:border-primary/40 text-slate-500 hover:text-primary transition-colors">
                      <Upload size={18} />
                      <span className="text-sm font-bold">
                        {cityRateUploading
                          ? "Uploading..."
                          : "Choose .xlsx / .xls / .csv file"}
                      </span>
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        className="hidden"
                        disabled={cityRateUploading}
                        onChange={handleUploadCityRates}
                      />
                    </label>
                    {cityRateUploadResult && (
                      <div className="text-xs bg-green-50 text-green-700 rounded-xl p-3 font-medium">
                        {cityRateUploadResult.rowsInFile} rows read ·{" "}
                        {cityRateUploadResult.ratesUpserted} rates saved ·
                        matched couriers:{" "}
                        {(cityRateUploadResult.matchedCouriers || []).join(", ") || "none"}
                        {cityRateUploadResult.skippedRows > 0 && (
                          <> · {cityRateUploadResult.skippedRows} rows skipped (missing city)</>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <form
                  onSubmit={handleManualRateSubmit}
                  className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-slate-100">
                    <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                      <Plus className="text-primary" size={18} /> Add / Update
                      One Route
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Set every courier's charge for this route in one go —
                      same as filling one row of the Excel sheet. Leave a
                      courier blank to skip it (its existing rate, if any,
                      stays untouched).
                    </p>
                  </div>
                  <div className="p-5 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder="Origin City"
                        value={manualRateForm.originCity}
                        onChange={(e) =>
                          setManualRateForm((f) => ({ ...f, originCity: e.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                      <input
                        type="text"
                        placeholder="Destination City"
                        value={manualRateForm.destinationCity}
                        onChange={(e) =>
                          setManualRateForm((f) => ({ ...f, destinationCity: e.target.value }))
                        }
                        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                      />
                    </div>

                    {couriers.length === 0 ? (
                      <p className="text-xs text-slate-400">
                        Add couriers on the Couriers tab first.
                      </p>
                    ) : (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {couriers.map((c) => (
                          <div key={c._id} className="flex items-center gap-2">
                            <span className="flex-1 text-xs font-bold text-slate-600 truncate">
                              {c.name}
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              placeholder="₹"
                              value={manualRateForm.charges[c._id] ?? ""}
                              onChange={(e) =>
                                setManualRateForm((f) => ({
                                  ...f,
                                  charges: { ...f.charges, [c._id]: e.target.value },
                                }))
                              }
                              className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={manualRateSaving || couriers.length === 0}
                      className="w-full bg-[color:var(--primary)] hover:opacity-90 disabled:opacity-50 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all">
                      <Save size={16} />
                      {manualRateSaving ? "Saving..." : "Save Rates"}
                    </button>
                  </div>
                </form>
              </div>

              <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-5 border-b border-slate-100">
                  <h2 className="text-base font-black text-slate-800 flex items-center gap-2">
                    <Route className="text-primary" size={18} /> Routes &amp;
                    Charges
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {groupedCityRates.length} routes priced · a route with no
                    charge for the customer's chosen courier is not bookable
                    · each route applies both ways (Surat → Indore also
                    covers Indore → Surat) unless you add the reverse
                    direction separately with its own rate
                  </p>
                </div>
                <div className="divide-y divide-slate-100">
                  {cityRatesLoading ? (
                    <p className="text-sm text-slate-400 text-center py-10 font-medium">
                      Loading...
                    </p>
                  ) : groupedCityRates.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-10 font-medium">
                      No rates uploaded yet.
                    </p>
                  ) : (
                    groupedCityRates.map((route) => (
                      <div
                        key={`${route.originCity}__${route.destinationCity}`}
                        className="p-4 space-y-2">
                        <div className="text-sm font-black text-slate-800 flex items-center gap-1.5">
                          {route.originCity}
                          <ArrowRight size={14} className="text-slate-400" />
                          {route.destinationCity}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {route.rates.map((rate) => (
                            <span
                              key={rate._id}
                              className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full bg-slate-100 text-slate-700">
                              {rate.courierCompanyId?.name || "Unknown courier"}: ₹
                              {rate.charge}
                              <button
                                type="button"
                                onClick={() => setRateRowToDelete(rate)}
                                className="text-slate-400 hover:text-red-600"
                                title="Remove">
                                <XCircle size={12} />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB: CUSTOMER REVIEWS */}
          {activeTab === "reviews" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-slate-800">
                    Courier Reviews
                  </h2>
                  <p className="text-xs text-slate-500 font-medium mt-0.5">
                    Ratings submitted after completed courier deliveries
                  </p>
                </div>
                <button
                  type="button"
                  onClick={fetchParcelReviews}
                  className="px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-600 hover:bg-white">
                  Refresh
                </button>
              </div>

              {reviewsLoading ? (
                <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-sm text-slate-400">
                  Loading reviews…
                </div>
              ) : parcelReviews.length === 0 ? (
                <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-sm text-slate-400">
                  No courier reviews yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {parcelReviews.map((review) => (
                    <div
                      key={review._id}
                      className="bg-white rounded-2xl border border-slate-100 p-4 shadow-sm flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <div className="flex items-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <Star
                                key={n}
                                size={14}
                                className={
                                  n <= Number(review.rating)
                                    ? "fill-amber-400 text-amber-400"
                                    : "text-slate-200"
                                }
                              />
                            ))}
                          </div>
                          <span
                            className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                              review.status === "approved"
                                ? "bg-orange-50 text-orange-700"
                                : "bg-slate-100 text-slate-500"
                            }`}>
                            {review.status}
                          </span>
                        </div>
                        <p className="text-sm font-bold text-slate-800">
                          {review.customerId?.name || "Customer"}
                          {review.customerId?.phone ? (
                            <span className="text-slate-400 font-medium">
                              {" "}
                              · {review.customerId.phone}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                          {review.comment || "No written review"}
                        </p>
                        <p className="text-[11px] text-slate-400 font-semibold mt-2">
                          {review.createdAt
                            ? new Date(review.createdAt).toLocaleString("en-IN")
                            : ""}
                          {review.parcelId?._id
                            ? ` · Courier #${String(review.parcelId._id).slice(-6)}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {review.status === "approved" ? (
                          <button
                            type="button"
                            onClick={() =>
                              handleReviewStatus(review._id, "hidden")
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50">
                            <EyeOff size={14} /> Hide
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              handleReviewStatus(review._id, "approved")
                            }
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border border-orange-200 text-orange-700 bg-orange-50 hover:bg-orange-100">
                            <Eye size={14} /> Publish
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: REVENUE REPORTS */}
          {activeTab === "reports" && (
            <div className="space-y-6">
              {/* Stat grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
                <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-sm flex items-center gap-4">
                  <div className="h-12 w-12 bg-orange-50 rounded-2xl flex items-center justify-center text-orange-600 shrink-0">
                    <ClipboardList size={24} />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Total Bookings
                    </span>
                    <span className="text-2xl font-black text-slate-800 mt-1 block">
                      {reports.totalDeliveries}
                    </span>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-sm flex items-center gap-4">
                  <div className="h-12 w-12 bg-green-50 rounded-2xl flex items-center justify-center text-green-600 shrink-0">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Completed
                    </span>
                    <span className="text-2xl font-black text-slate-800 mt-1 block">
                      {reports.completed}
                    </span>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-sm flex items-center gap-4">
                  <div className="h-12 w-12 bg-red-50 rounded-2xl flex items-center justify-center text-red-600 shrink-0">
                    <XCircle size={24} />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Cancelled
                    </span>
                    <span className="text-2xl font-black text-slate-800 mt-1 block">
                      {reports.cancelled}
                    </span>
                  </div>
                </div>

                <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-sm flex items-center gap-4">
                  <div className="h-12 w-12 bg-orange-50 rounded-2xl flex items-center justify-center text-orange-600 shrink-0">
                    <DollarSign size={24} />
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Total Revenue
                    </span>
                    <span className="text-2xl font-black text-slate-800 mt-1 block">
                      ₹{reports.revenue}
                    </span>
                  </div>
                </div>
              </div>

              {/* Extra details card */}
              <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm w-full space-y-4">
                <h3 className="text-base font-black text-slate-800">
                  Financial Insights
                </h3>
                <p className="text-xs text-slate-400 font-medium">
                  Summary calculations based on all completed courier deliveries.
                </p>
                <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-100 text-xs">
                  <div className="bg-slate-50 p-4 rounded-2xl">
                    <span className="text-slate-400 font-bold block uppercase">
                      Admin Commission
                    </span>
                    <span className="text-lg font-black text-slate-800 mt-1 block">
                      ₹{Number(reports.adminCommission || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-medium block mt-1">
                      Delivery charge − Rider payout
                    </span>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl">
                    <span className="text-slate-400 font-bold block uppercase">
                      Riders Payout (₹
                      {reports.riderPerKmRate ?? pricing.riderPerKmRate}/km)
                    </span>
                    <span className="text-lg font-black text-slate-800 mt-1 block">
                      ₹{Number(reports.riderPayout || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-medium block mt-1">
                      Distance (accept → pickup) × rate
                    </span>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl col-span-2">
                    <span className="text-slate-400 font-bold block uppercase">
                      Courier Charge Collected (pass-through)
                    </span>
                    <span className="text-lg font-black text-slate-800 mt-1 block">
                      ₹{Number(reports.courierChargeCollected || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-medium block mt-1">
                      Collected on behalf of courier companies — not platform
                      revenue, excluded from Admin Commission above
                    </span>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl col-span-2">
                    <span className="text-slate-400 font-bold block uppercase">
                      GST Collected (tax, pass-through)
                    </span>
                    <span className="text-lg font-black text-slate-800 mt-1 block">
                      ₹{Number(reports.gstCollected || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-medium block mt-1">
                      Government's tax, not platform revenue — excluded from
                      Admin Commission above (also excluded from the courier
                      pass-through, since GST applies to the delivery charge)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Selected Parcel Details Modal */}
      {selectedParcel && (
        <div
          ref={parcelDetailModalRef}
          className="fixed inset-0 z-[1000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden overscroll-none"
          data-lenis-prevent>
          <style>{`
            .modal-scroll-pad::-webkit-scrollbar {
              width: 10px;
              height: 10px;
            }
            .modal-scroll-pad::-webkit-scrollbar-track {
              background: #f1f5f9 !important;
              border-radius: 8px;
            }
            .modal-scroll-pad::-webkit-scrollbar-thumb {
              background: #cbd5e1 !important;
              border-radius: 8px;
              border: 2px solid #f1f5f9;
            }
            .modal-scroll-pad::-webkit-scrollbar-thumb:hover {
              background: #94a3b8 !important;
            }
          `}</style>
          <div className="bg-white rounded-3xl border border-slate-100 shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col relative overflow-hidden min-h-0">
            {/* Header - Fixed */}
            <div className="p-6 border-b border-slate-100 flex justify-between items-start shrink-0">
              <div>
                <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                  <Package className="text-primary" size={20} />
                  Courier Request Details
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Full logs, addresses, OTP validation, and uploaded proofs for
                  booking ID: #{selectedParcel._id.slice(-6)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* The same invoice the customer downloads — one server-side
                    builder, so the two copies can never disagree. */}
                <InvoiceDownloadButton
                  fetchInvoice={() =>
                    adminPorterApi.getBookingInvoice("parcel", selectedParcel._id)
                  }
                  label="Invoice"
                  size="sm"
                />
                <button
                  onClick={() => setSelectedParcel(null)}
                  className="p-1.5 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors">
                  <XCircle size={22} />
                </button>
              </div>
            </div>

            {/* Content - Scrollable */}
            <div
              ref={parcelDetailScrollRef}
              data-lenis-prevent
              data-lenis-prevent-wheel
              className="p-6 overflow-y-auto overscroll-contain space-y-6 flex-1 min-h-0 modal-scroll-pad"
              style={{
                WebkitOverflowScrolling: "touch",
                overscrollBehavior: "contain",
              }}>
              {selectedParcel.lateRefundRequest?.status === "requested" && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 space-y-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-800">
                      Late pickup refund pending
                    </p>
                    <p className="text-sm text-amber-900 mt-1">
                      Customer requested wallet compensation because Normal
                      pickup exceeded 30 minutes.
                      {String(selectedParcel.paymentMethod).toUpperCase() ===
                      "COD"
                        ? " COD full cash collection stays as-is."
                        : ""}
                    </p>
                    <div className="mt-3 rounded-xl bg-white/70 border border-amber-100 px-3 py-2.5 space-y-1">
                      <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
                        Delivery partner delay
                      </p>
                      <p className="text-lg font-black text-amber-950">
                        {selectedParcel.lateRefundRequest?.lateByLabel ||
                          selectedParcel.pickupSla?.lateByLabel ||
                          "Late"}
                      </p>
                      <p className="text-[11px] text-amber-800/90 font-medium">
                        SLA {selectedParcel.pickupSla?.minutes || 30} min from
                        accept
                        {selectedParcel.acceptedAt
                          ? ` · accepted ${new Date(
                              selectedParcel.acceptedAt,
                            ).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : ""}
                        {selectedParcel.lateRefundRequest?.deadlineAt ||
                        selectedParcel.pickupSla?.deadlineAt
                          ? ` · deadline ${new Date(
                              selectedParcel.lateRefundRequest?.deadlineAt ||
                                selectedParcel.pickupSla?.deadlineAt,
                            ).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : ""}
                      </p>
                      {selectedParcel.deliveryPartnerId?.name ? (
                        <p className="text-[11px] text-amber-900 font-semibold">
                          Captain: {selectedParcel.deliveryPartnerId.name}
                          {selectedParcel.deliveryPartnerId.phone
                            ? ` · ${selectedParcel.deliveryPartnerId.phone}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                    {selectedParcel.lateRefundRequest.reason ? (
                      <p className="text-xs text-amber-700 mt-2">
                        Reason: {selectedParcel.lateRefundRequest.reason}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <div className="flex-1">
                      <label className="text-[10px] font-bold uppercase text-amber-700 tracking-wider">
                        Wallet credit (₹)
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="0.01"
                        value={lateRefundAmount}
                        onChange={(e) => setLateRefundAmount(e.target.value)}
                        placeholder={String(selectedParcel.fare || "")}
                        className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-amber-300"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={lateRefundSaving}
                      onClick={async () => {
                        setLateRefundSaving(true);
                        try {
                          const amount =
                            lateRefundAmount === ""
                              ? undefined
                              : Number(lateRefundAmount);
                          const res = await parcelApi.adminApproveLateRefund(
                            selectedParcel._id,
                            Number.isFinite(amount) ? { amount } : {},
                          );
                          if (res.data?.success) {
                            toast.success("Refund credited to customer wallet");
                            setSelectedParcel(res.data.result);
                            setLateRefundAmount("");
                            fetchData?.();
                          } else {
                            toast.error(res.data?.message || "Approve failed");
                          }
                        } catch (error) {
                          toast.error(
                            error.response?.data?.message || "Approve failed",
                          );
                        } finally {
                          setLateRefundSaving(false);
                        }
                      }}
                      className="px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-60">
                      {lateRefundSaving ? "Saving..." : "Approve → Wallet"}
                    </button>
                    <button
                      type="button"
                      disabled={lateRefundSaving}
                      onClick={async () => {
                        setLateRefundSaving(true);
                        try {
                          const res = await parcelApi.adminRejectLateRefund(
                            selectedParcel._id,
                            {},
                          );
                          if (res.data?.success) {
                            toast.success("Late refund request rejected");
                            setSelectedParcel(res.data.result);
                            fetchData?.();
                          } else {
                            toast.error(res.data?.message || "Reject failed");
                          }
                        } catch (error) {
                          toast.error(
                            error.response?.data?.message || "Reject failed",
                          );
                        } finally {
                          setLateRefundSaving(false);
                        }
                      }}
                      className="px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider bg-white border border-amber-200 text-slate-700 hover:bg-amber-100 disabled:opacity-60">
                      Reject
                    </button>
                  </div>
                </div>
              )}
              {selectedParcel.lateRefundRequest?.status === "approved" && (
                <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900 font-semibold space-y-1">
                  <p>
                    Late refund approved: ₹
                    {Number(
                      selectedParcel.lateRefundRequest.approvedAmount || 0,
                    ).toFixed(2)}{" "}
                    credited to customer wallet.
                  </p>
                  {(selectedParcel.lateRefundRequest.lateByLabel ||
                    selectedParcel.pickupSla?.lateByLabel) && (
                    <p className="text-xs font-medium text-orange-800">
                      Partner was{" "}
                      {selectedParcel.lateRefundRequest.lateByLabel ||
                        selectedParcel.pickupSla?.lateByLabel}
                      .
                    </p>
                  )}
                </div>
              )}
              {selectedParcel.lateRefundRequest?.status === "rejected" && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 font-semibold">
                  Late refund request was rejected.
                </div>
              )}

              {/* Grid details */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Status
                  </span>
                  <span
                    className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase block w-fit mt-1.5 ${
                      selectedParcel.status === "DELIVERED"
                        ? "bg-green-100 text-green-700"
                        : selectedParcel.status === "CANCELLED"
                          ? "bg-red-100 text-red-600"
                          : "bg-orange-100 text-orange-700"
                    }`}>
                    {selectedParcel.status}
                  </span>
                </div>

                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Delivery Speed
                  </span>
                  <span
                    className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase block w-fit mt-1.5 ${
                      selectedParcel.deliverySpeed === "express"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-slate-200 text-slate-600"
                    }`}>
                    {selectedParcel.deliverySpeed === "express"
                      ? "Express · 10 min"
                      : "Normal · 30 min"}
                  </span>
                </div>

                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Payment
                  </span>
                  <span className="text-sm font-black text-slate-800 mt-1 block">
                    {selectedParcel.paymentMethod || "—"} ·{" "}
                    {selectedParcel.paymentStatus || "—"}
                  </span>
                  {String(selectedParcel.paymentMethod).toUpperCase() ===
                    "COD" && (
                    <div className="mt-2 text-[11px] text-slate-600 space-y-0.5 font-medium">
                      <p>
                        Collect: ₹
                        {Number(
                          selectedParcel.codSettlement?.collectAmount ||
                            selectedParcel.fare ||
                            0,
                        ).toFixed(2)}
                      </p>
                      <p>
                        COD status:{" "}
                        <span className="font-bold text-slate-800">
                          {selectedParcel.codSettlement?.status || "—"}
                        </span>
                      </p>
                    </div>
                  )}
                  {selectedParcel.paymentStatus === "REFUNDED" && (
                    <p className="mt-2 text-[11px] font-bold text-orange-700">
                      ₹{Number(selectedParcel.payableFare || selectedParcel.fare || 0).toFixed(2)}{" "}
                      refunded to the customer's original payment method
                    </p>
                  )}
                </div>

                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Fare & Weight
                  </span>
                  <span className="text-sm font-black text-slate-800 mt-1 block">
                    ₹{selectedParcel.fare} ({selectedParcel.weight} KG)
                  </span>
                  {selectedParcel.fareBreakdown && (
                    <span className="text-[11px] text-slate-500 font-medium mt-1 block">
                      Delivery ₹{selectedParcel.fareBreakdown.baseFare || 0}
                      {Number(selectedParcel.fareBreakdown.courierCharge) > 0 &&
                        ` + Courier (${selectedParcel.courierCompany || "—"}) ₹${selectedParcel.fareBreakdown.courierCharge}`}
                    </span>
                  )}
                </div>

                {selectedParcel.riderEarningBreakdown && (
                  <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Rider Payout vs Admin Margin
                    </span>
                    <span className="text-sm font-black text-slate-800 mt-1 block">
                      Rider ₹{selectedParcel.riderEarningBreakdown.earning.toFixed(2)}
                      {" · "}
                      Admin ₹
                      {Math.max(
                        0,
                        Number(selectedParcel.fareBreakdown?.baseFare || 0) -
                          selectedParcel.riderEarningBreakdown.earning,
                      ).toFixed(2)}
                    </span>
                    <span className="text-[11px] text-slate-500 font-medium mt-1 block">
                      {selectedParcel.riderEarningBreakdown.earning > 0
                        ? `Rider: ${selectedParcel.riderEarningBreakdown.distanceKm} km (accept → pickup) × ₹${selectedParcel.riderEarningBreakdown.ratePerKm}/km`
                        : "Rider hasn't accepted yet — payout not computed"}
                      {" · Admin margin = Delivery charge − Rider payout (courier charge is a pass-through, not platform revenue)"}
                    </span>
                  </div>
                )}

                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Verification OTP
                  </span>
                  <span className="text-sm font-black text-slate-800 mt-1 block tracking-wider">
                    {selectedParcel.otp || "N/A"}
                  </span>
                </div>

                <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Route Type
                  </span>
                  <span className="text-sm font-black text-slate-800 mt-1 block capitalize">
                    {selectedParcel.parcelType || "outstation"}
                  </span>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-medium">
                    {selectedParcel.courierCompanyId?.name
                      ? `Courier: ${selectedParcel.courierCompanyId.name}${
                          selectedParcel.courierCompanyId.phone
                            ? ` (${selectedParcel.courierCompanyId.phone})`
                            : ""
                        }`
                      : selectedParcel.sellerId?.shopName
                        ? `Seller hub: ${selectedParcel.sellerId.shopName}`
                        : "No courier assigned"}
                  </p>
                </div>
              </div>

              {/* Address Details */}
              <div className="space-y-4 text-xs">
                {/* What the customer actually filled in at booking. The API
                    always sent these; the dashboard simply never showed them,
                    so support had no way to answer "what is in this parcel". */}
                <div className="border-t border-slate-100 pt-4">
                  <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                    Package
                  </strong>
                  <p className="font-bold text-slate-700">
                    {[
                      selectedParcel.packageDetails?.packageSegment,
                      selectedParcel.packageDetails?.packageCategory ||
                        selectedParcel.packageDetails?.packageType,
                      selectedParcel.packageDetails?.weight
                        ? `${selectedParcel.packageDetails.weight} kg`
                        : selectedParcel.weight
                          ? `${selectedParcel.weight} kg`
                          : "",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Not specified"}
                  </p>
                  {selectedParcel.packageDetails?.description ? (
                    <p className="text-slate-500 mt-0.5 leading-relaxed">
                      {selectedParcel.packageDetails.description}
                    </p>
                  ) : null}
                </div>

                {(selectedParcel.courierCompany ||
                  selectedParcel.destinationCity) && (
                  <div className="border-t border-slate-100 pt-4">
                    <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                      Onward Courier
                    </strong>
                    <p className="font-bold text-slate-700">
                      {selectedParcel.courierCompany || "—"}
                    </p>
                    {selectedParcel.destinationCity ? (
                      <p className="text-slate-500 mt-0.5">
                        Destination: {selectedParcel.destinationCity}
                      </p>
                    ) : null}
                  </div>
                )}

                {(selectedParcel.preferredPickupDate ||
                  selectedParcel.pickupWindow) && (
                  <div className="border-t border-slate-100 pt-4">
                    <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                      Requested Pickup
                    </strong>
                    <p className="font-bold text-slate-700">
                      {selectedParcel.preferredPickupDate
                        ? new Date(
                            selectedParcel.preferredPickupDate,
                          ).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "Any day"}
                      {selectedParcel.pickupWindow
                        ? ` · ${selectedParcel.pickupWindow}`
                        : ""}
                    </p>
                  </div>
                )}

                <div className="border-t border-slate-100 pt-4">
                  <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                    Pickup Address
                  </strong>
                  <p className="font-bold text-slate-700">
                    {selectedParcel.pickupAddress?.name} (
                    {selectedParcel.pickupAddress?.phone})
                  </p>
                  <p className="text-slate-500 mt-0.5 leading-relaxed">
                    {selectedParcel.pickupAddress?.fullAddress}
                  </p>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                    {selectedParcel.courierCompanyId ? "Drop at Courier" : "Dropoff Address"}
                  </strong>
                  <p className="font-bold text-slate-700">
                    {selectedParcel.dropAddress?.name} (
                    {selectedParcel.dropAddress?.phone})
                  </p>
                  <p className="text-slate-500 mt-0.5 leading-relaxed">
                    {selectedParcel.dropAddress?.fullAddress}
                  </p>
                </div>

                {selectedParcel.receiverAddress && (
                  <div className="border-t border-slate-100 pt-4">
                    <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                      Receiver (final delivery, via courier)
                    </strong>
                    <p className="font-bold text-slate-700">
                      {selectedParcel.receiverAddress.name} (
                      {selectedParcel.receiverAddress.phone})
                    </p>
                    <p className="text-slate-500 mt-0.5 leading-relaxed">
                      {selectedParcel.receiverAddress.fullAddress}
                      {selectedParcel.receiverAddress.city
                        ? `, ${selectedParcel.receiverAddress.city}`
                        : ""}
                      {selectedParcel.receiverAddress.state
                        ? `, ${selectedParcel.receiverAddress.state}`
                        : ""}
                      {selectedParcel.receiverAddress.pincode
                        ? ` - ${selectedParcel.receiverAddress.pincode}`
                        : ""}
                    </p>
                  </div>
                )}

                {selectedParcel.deliveryPartnerId && (
                  <div className="border-t border-slate-100 pt-4">
                    <strong className="text-slate-800 block text-xs mb-1 uppercase tracking-wider">
                      Assigned Rider
                    </strong>
                    <p className="font-bold text-slate-700">
                      {selectedParcel.deliveryPartnerId.name} (
                      {selectedParcel.deliveryPartnerId.phone})
                    </p>
                  </div>
                )}
              </div>

              {/* Proof Photos Section */}
              <div className="space-y-4 border-t border-slate-100 pt-4">
                <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider">
                  Delivery Evidence Photos
                  {selectedParcelLoading ? (
                    <span className="ml-2 text-[10px] font-bold text-slate-400 normal-case tracking-normal">
                      Refreshing…
                    </span>
                  ) : null}
                </h4>

                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Pickup at Customer
                    </span>
                    {selectedParcel.pickupProofImage ? (
                      <div className="h-40 w-full rounded-2xl overflow-hidden border border-slate-100 shadow-sm bg-slate-50">
                        <img
                          src={selectedParcel.pickupProofImage}
                          alt="Pickup Proof"
                          className="h-full w-full object-cover cursor-zoom-in hover:scale-105 transition-transform"
                          onClick={() => setPickupProofPreview(selectedParcel.pickupProofImage)}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                            const fallback = e.currentTarget.nextElementSibling;
                            if (fallback) fallback.classList.remove("hidden");
                          }}
                        />
                        <div className="hidden h-full w-full flex items-center justify-center p-3 text-[10px] text-rose-500 font-semibold text-center">
                          Image failed to load
                        </div>
                      </div>
                    ) : (
                      <div className="h-40 w-full rounded-2xl border border-dashed border-slate-200 flex items-center justify-center text-center p-3 text-[10px] text-slate-400 bg-slate-50/50">
                        No pickup proof uploaded
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {pickupProofPreview &&
                createPortal(
                  <div
                    className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/80 p-4"
                    onClick={() => setPickupProofPreview(null)}
                  >
                    <button
                      type="button"
                      onClick={() => setPickupProofPreview(null)}
                      className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
                    >
                      <XCircle size={22} />
                    </button>
                    <img
                      src={pickupProofPreview}
                      alt="Pickup proof"
                      className="max-h-[90vh] max-w-full rounded-2xl object-contain"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>,
                  document.body,
                )}

              {/* Event Log — the document only ever holds the current
                  status; this is what actually answers "what happened to
                  this booking, and when, and who did it". */}
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider">
                  Status History ({(selectedParcel.timeline || []).length})
                </h4>
                {(selectedParcel.timeline || []).length === 0 ? (
                  <p className="text-[11px] text-slate-400">
                    No event history recorded for this booking yet.
                  </p>
                ) : (
                  <ol className="space-y-0">
                    {selectedParcel.timeline.map((e, i) => (
                      <li key={i} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                          {i < selectedParcel.timeline.length - 1 ? (
                            <span className="my-1 w-px flex-1 bg-slate-200" />
                          ) : null}
                        </div>
                        <div className="flex-1 pb-3">
                          <div className="flex items-center gap-2">
                            <p className="text-[12px] font-bold text-slate-800">
                              {String(e.status || "").replace(/_/g, " ")}
                            </p>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase text-slate-500">
                              {e.actor}
                            </span>
                          </div>
                          {e.note ? (
                            <p className="mt-0.5 text-[11px] text-slate-500">{e.note}</p>
                          ) : null}
                          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">
                            <Clock className="h-3 w-3" />
                            {e.at
                              ? new Date(e.at).toLocaleString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>

            {/* Footer - Fixed */}
            <div className="p-4 bg-slate-50 border-t border-slate-100 shrink-0">
              <button
                type="button"
                onClick={() => setSelectedParcel(null)}
                className="w-full py-2.5 bg-white border border-slate-200 hover:bg-slate-50 font-bold text-xs text-slate-700 rounded-xl transition-all uppercase tracking-wider">
                Close Details
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Courier Modal */}
      {courierEditModalOpen &&
        createPortal(
          <div
            ref={courierEditModalRef}
            className="fixed inset-0 z-[1000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden overscroll-none touch-none">
            <style>{`
              .modal-scroll-pad::-webkit-scrollbar {
                width: 10px;
                height: 10px;
              }
              .modal-scroll-pad::-webkit-scrollbar-track {
                background: #f1f5f9 !important;
                border-radius: 8px;
              }
              .modal-scroll-pad::-webkit-scrollbar-thumb {
                background: #cbd5e1 !important;
                border-radius: 8px;
                border: 2px solid #f1f5f9;
              }
              .modal-scroll-pad::-webkit-scrollbar-thumb:hover {
                background: #94a3b8 !important;
              }
            `}</style>
            <div
              className="absolute inset-0 z-0"
              onClick={closeCourierEditModal}
              aria-hidden="true"
            />
            <div
              data-courier-edit-dialog
              className="relative z-10 bg-white rounded-3xl border border-slate-100 shadow-xl max-w-lg w-full overflow-hidden flex flex-col touch-auto"
              style={{ height: "min(90vh, calc(100dvh - 2rem))" }}
              onClick={(e) => e.stopPropagation()}>
              <div className="p-5 border-b border-slate-100 flex justify-between items-start shrink-0">
                <div>
                  <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <Pencil className="text-primary" size={18} />
                    {editingCourierIsOther
                      ? "Edit “Other” Option"
                      : "Edit Courier Company"}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    {editingCourierIsOther
                      ? "This option has no editable fields of its own."
                      : "Update name, contact, zones, and visibility."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeCourierEditModal}
                  className="p-1.5 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors">
                  <XCircle size={22} />
                </button>
              </div>

              <form
                onSubmit={handleUpdateCourier}
                className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div
                  ref={courierEditScrollRef}
                  className="p-5 space-y-4 overflow-y-auto overscroll-contain flex-1 min-h-0 modal-scroll-pad"
                  style={{
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                  }}>
                  {editingCourierIsOther ? (
                    <div className="rounded-xl bg-primary/5 border border-primary/20 px-3 py-2.5">
                      <p className="text-xs font-bold text-slate-700">
                        “Other” courier option
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        Customers who pick this option type their own courier
                        company name. You can only toggle whether this option
                        is shown.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">
                          Company Name
                        </label>
                        <input
                          type="text"
                          required
                          value={editCourierForm.name}
                          onChange={(e) =>
                            setEditCourierForm((f) => ({
                              ...f,
                              name: maskName(e.target.value, 80),
                            }))
                          }
                          placeholder="e.g. Blue Dart"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">
                          Contact Phone
                        </label>
                        <input
                          type="tel"
                          inputMode="numeric"
                          required
                          value={editCourierForm.phone}
                          onChange={(e) =>
                            setEditCourierForm((f) => ({
                              ...f,
                              phone: maskPhone(e.target.value),
                            }))
                          }
                          placeholder="10-digit number"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">
                          Zones
                        </label>
                        <div className="rounded-xl border border-slate-200 p-3 space-y-2 max-h-56 overflow-y-auto">
                          <label className="flex items-center gap-2 text-xs font-bold text-primary cursor-pointer pb-2 border-b border-slate-100">
                            <input
                              type="checkbox"
                              checked={editCourierForm.allZones}
                              onChange={(e) =>
                                setEditCourierForm((f) => ({
                                  ...f,
                                  allZones: e.target.checked,
                                  zoneIds: e.target.checked ? [] : f.zoneIds,
                                }))
                              }
                              className="accent-primary h-4 w-4"
                            />
                            All Zones (Global — every zone)
                          </label>
                          {zones.length === 0 ? (
                            <p className="text-xs text-slate-400">
                              No active zones configured yet.
                            </p>
                          ) : (
                            zones.map((zone) => (
                              <label
                                key={zone._id}
                                className={`flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer ${
                                  editCourierForm.allZones
                                    ? "opacity-40 pointer-events-none"
                                    : ""
                                }`}>
                                <input
                                  type="checkbox"
                                  disabled={editCourierForm.allZones}
                                  checked={editCourierForm.zoneIds.includes(
                                    String(zone._id),
                                  )}
                                  onChange={(e) =>
                                    setEditCourierForm((f) => ({
                                      ...f,
                                      zoneIds: e.target.checked
                                        ? [...f.zoneIds, String(zone._id)]
                                        : f.zoneIds.filter(
                                            (id) => id !== String(zone._id),
                                          ),
                                    }))
                                  }
                                  className="accent-primary h-4 w-4"
                                />
                                {formatZoneLabel(zone.name, zone.city)}
                              </label>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">
                          Sort Order
                        </label>
                        <input
                          type="number"
                          step="1"
                          value={editCourierForm.sortOrder}
                          onChange={(e) =>
                            setEditCourierForm((f) => ({
                              ...f,
                              sortOrder: maskAmount(e.target.value, { decimals: 0, max: 4 }),
                            }))
                          }
                          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
                        />
                      </div>
                    </>
                  )}

                  <label className="flex items-center gap-2 text-sm font-bold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editCourierForm.isActive}
                      onChange={(e) =>
                        setEditCourierForm((f) => ({
                          ...f,
                          isActive: e.target.checked,
                        }))
                      }
                      className="accent-primary h-4 w-4"
                    />
                    Active (shown on customer booking form)
                  </label>
                </div>

                <div className="p-5 border-t border-slate-100 shrink-0 flex gap-2 bg-white">
                  <button
                    type="button"
                    onClick={closeCourierEditModal}
                    className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={courierSaving}
                    className="flex-1 bg-[color:var(--primary)] hover:opacity-90 disabled:opacity-50 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all">
                    <Save size={16} />
                    {courierSaving ? "Saving..." : "Update"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* Delete Courier Confirm Modal */}
      {courierToDelete && (
        <div className="fixed inset-0 z-[1000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden overscroll-none">
          <div
            className="absolute inset-0 z-0"
            onClick={() => !courierDeleting && setCourierToDelete(null)}
            aria-hidden="true"
          />
          <div
            className="relative z-10 bg-white rounded-3xl border border-slate-100 shadow-xl max-w-sm w-full overflow-hidden p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                <Trash2 size={18} />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-800">
                  Delete Courier?
                </h3>
                <p className="text-sm text-slate-500 font-medium mt-1">
                  Remove{" "}
                  <span className="font-black text-slate-800">
                    {courierToDelete.name}
                  </span>{" "}
                  from the booking list. This cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={courierDeleting}
                onClick={() => setCourierToDelete(null)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                disabled={courierDeleting}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  confirmDeleteCourier();
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm disabled:opacity-50">
                {courierDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete City Rate Confirm Modal */}
      {rateRowToDelete && (
        <div className="fixed inset-0 z-[1000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden overscroll-none">
          <div
            className="absolute inset-0 z-0"
            onClick={() => setRateRowToDelete(null)}
            aria-hidden="true"
          />
          <div
            className="relative z-10 bg-white rounded-3xl border border-slate-100 shadow-xl max-w-sm w-full overflow-hidden p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                <Trash2 size={18} />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-800">
                  Remove This Rate?
                </h3>
                <p className="text-sm text-slate-500 font-medium mt-1">
                  {rateRowToDelete.courierCompanyId?.name || "This courier"}{" "}
                  will no longer be bookable from{" "}
                  <span className="font-black text-slate-800">
                    {rateRowToDelete.originCity}
                  </span>{" "}
                  to{" "}
                  <span className="font-black text-slate-800">
                    {rateRowToDelete.destinationCity}
                  </span>
                  .
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setRateRowToDelete(null)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteCityRate}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm">
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default AdminParcelDashboard;
