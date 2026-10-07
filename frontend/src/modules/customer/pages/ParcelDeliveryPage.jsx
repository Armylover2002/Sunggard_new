import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  MapPin,
  Package,
  ArrowRight,
  ArrowLeft,
  Truck,
  Clock,
  User,
  Phone,
  AlertTriangle,
  ChevronDown,
  Building2,
  CalendarDays,
  Check,
  Store,
  Navigation,
} from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  checkPersonName,
  checkPhone,
  checkPincode,
  checkAddressLine,
  checkPlaceName,
  firstProblem,
  sanitizeNameInput,
  sanitizePhoneInput,
  NAME_MAX,
  PHONE_MAX,
} from "../utils/bookingValidation";
import { parcelApi } from "../services/parcelApi";
import { customerApi } from "../services/customerApi";
import MapPicker from "../../../shared/components/MapPicker";
import Modal from "../../../shared/components/ui/Modal";
import { zonesApi } from "@shared/services/zonesApi";
import { zonesContainingPoint } from "@shared/utils/zoneGeometry";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import { openParcelRazorpayCheckout } from "../utils/parcelRazorpay";
import ParcelReviewsSection from "../components/parcel/ParcelReviewsSection";
import { getJSON, setJSON, remove as removeStored } from "@core/utils/storage";
import { STORAGE_KEYS } from "@core/utils/storageKeys";
import {
  MONO,
  Caption,
  Money,
  RouteRail,
  Barcode,
  TearLine,
  Sheet,
  Field,
  inputClass,
  Segmented,
  WeightBox,
  LeaderRow,
  Stamp,
  StepPane,
  stagger,
  stackItem,
} from "../components/parcel/waybillKit";

const FALLBACK_COURIER_COMPANIES = [
  { id: "", name: "Blue Dart" },
  { id: "", name: "DTDC" },
  { id: "", name: "Delhivery" },
  { id: "", name: "India Post" },
  { id: "", name: "Ekart" },
  { id: "", name: "Ecom Express" },
  { id: "", name: "XpressBees" },
  { id: "", name: "FedEx" },
  { id: "", name: "DHL" },
  { id: "", name: "Shadowfax" },
];

const BOOKING_DURATION_MODES = [
  { value: "one_day", label: "One day", helper: "Today only" },
  { value: "by_date", label: "Until a date", helper: "Pick a date and time" },
];

const MAX_BOOKING_DAYS = 30;

// Pickup schedule: One Day sends the request now; Until a date sends it at the chosen date and time.
const pickupScheduleProblem = (dateInput, timeInput) => {
  if (!dateInput) return "Pick the pickup date.";
  if (!timeInput) return "Pick the pickup time.";
  if (dateInput < todayDateInputValue()) return "The pickup date cannot be in the past.";
  if (dateInput > addDaysToDateInput(MAX_BOOKING_DAYS))
    return `The pickup date cannot be more than ${MAX_BOOKING_DAYS} days ahead.`;
  const at = new Date(`${dateInput}T${timeInput}:00`);
  if (at.getTime() - Date.now() < 10 * 60 * 1000)
    return "Pick a pickup time at least 10 minutes from now.";
  return null;
};

const resolveBookingDurationParams = (mode, { preferredPickupDate, pickupTime }) => {
  if (mode === "one_day") {
    return {
      pickupWindow: "today",
      pickupWindowDays: 0,
      preferredPickupDate: todayDateInputValue(),
      pickupTime: "",
    };
  }
  return {
    pickupWindow: "specific",
    pickupWindowDays: null,
    preferredPickupDate,
    pickupTime,
  };
};

const formatBookingDate = (dateInput) =>
  new Date(dateInput).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** Hidden from booking UI; backend still requires a package type. */
const DEFAULT_PACKAGE_TYPE = "other";

const DELIVERY_SPEED_OPTIONS = [
  { value: "normal", label: "Normal", timeLabel: "30 min" },
  { value: "express", label: "Express", timeLabel: "10 min" },
];

const addDaysToDateInput = (days) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const todayDateInputValue = () => addDaysToDateInput(0);

const formatInr = (value) => `₹${Number(value || 0).toFixed(2)}`;

/** The waybill's four field groups, named the way a consignment note is. */
const STEPS = [
  { key: "from", label: "From", heading: "Where do we collect it?" },
  { key: "to", label: "To", heading: "Which counter does it go to?" },
  { key: "what", label: "What", heading: "What's in the courier?" },
  { key: "pay", label: "Pay", heading: "Check the fare and book" },
];

/** Keeps dropdown menus inside the viewport (flips up + scrolls). */
const useInScreenMenu = (
  open,
  onClose,
  itemCount = 1,
  estimatedItemHeight = 48,
) => {
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);

  const updatePosition = useCallback(() => {
    if (!open || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const gutter = 8;
    const preferredHeight = Math.min(
      280,
      Math.max(160, itemCount * estimatedItemHeight + 8),
    );
    const spaceBelow = window.innerHeight - rect.bottom - gutter;
    const spaceAbove = rect.top - gutter;
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      Math.min(preferredHeight, openUpward ? spaceAbove : spaceBelow),
    );

    setMenuStyle({
      position: "fixed",
      left: Math.max(
        gutter,
        Math.min(rect.left, window.innerWidth - rect.width - gutter),
      ),
      width: rect.width,
      maxHeight,
      zIndex: 9999,
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + 6, top: "auto" }
        : { top: rect.bottom + 6, bottom: "auto" }),
    });
  }, [open, itemCount, estimatedItemHeight]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const onReposition = () => updatePosition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      // Clearing on teardown keeps the menu from flashing at a stale position
      // the next time it opens, without a cascading render while open.
      setMenuStyle(null);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      const inRoot = rootRef.current?.contains(event.target);
      const inList = listRef.current?.contains(event.target);
      if (!inRoot && !inList) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return { rootRef, listRef, menuStyle };
};

const menuClass =
  "overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white shadow-[0_20px_50px_-20px_rgba(15,23,42,0.45)]";

const CourierCompanySelect = ({ companies, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, listRef, menuStyle } = useInScreenMenu(
    open,
    close,
    (companies?.length || 0) + 1,
    56,
  );

  const selected = useMemo(
    () =>
      companies.find((c) => (c.id && c.id === value) || c.name === value) ||
      null,
    [companies, value],
  );

  const selectedValue = selected ? selected.id || selected.name : "";

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          inputClass(Boolean(selected)),
          "pr-10 text-left min-h-[50px]",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}>
        {selected ? (
          <span className="flex items-center justify-between gap-2 pr-1">
            <span className="font-semibold text-slate-900 truncate">
              {selected.name}
            </span>
          </span>
        ) : (
          <span className="text-slate-400">Pick a courier company</span>
        )}
      </button>
      <ChevronDown
        size={16}
        className={`absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none transition-transform duration-200 ${
          open ? "rotate-180" : ""
        }`}
      />

      {open &&
        menuStyle &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            style={menuStyle}
            className={menuClass}>
            <button
              type="button"
              role="option"
              aria-selected={!selectedValue}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="w-full px-4 py-3 text-left text-sm text-slate-400 hover:bg-slate-50 border-b border-slate-100">
              Pick a courier company
            </button>
            {companies.map((company) => {
              const optionValue = company.id || company.name;
              const isSelected = optionValue === selectedValue;
              return (
                <button
                  key={optionValue}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(optionValue);
                    setOpen(false);
                  }}
                  className={`w-full px-4 py-3 text-left transition-colors border-b border-slate-50 last:border-b-0 ${
                    isSelected
                      ? "bg-[color:var(--primary)]/5"
                      : "hover:bg-slate-50"
                  }`}>
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`text-sm font-semibold truncate ${
                        isSelected
                          ? "text-[color:var(--primary)]"
                          : "text-slate-800"
                      }`}>
                      {company.isOther ? "Another company" : company.name}
                    </span>
                  </div>
                </button>
              );
            })}
            {companies.length === 0 && (
              <p className="px-4 py-5 text-xs text-slate-400 text-center">
                No courier companies available yet
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
};

/**
 * The page's thesis, drawn: we carry the first leg, the courier carries the
 * rest. Solid brand line = the part SunGguard does; dashed = the courier's.
 */
const HandoffDiagram = ({ counter, destination, compact = false }) => {
  const reduce = useReducedMotion();
  const nodes = [
    { icon: MapPin, label: "Your door", tone: "brand" },
    { icon: Store, label: counter || "Courier counter", tone: "brand" },
    { icon: Navigation, label: destination || "Destination", tone: "muted" },
  ];

  return (
    <div className={compact ? "py-1" : "py-2"}>
      <div className="flex items-start">
        {nodes.map((node, i) => (
          <React.Fragment key={node.label + i}>
            <div className="flex flex-col items-center gap-1.5 w-[74px] shrink-0">
              <span
                className={`grid place-items-center h-8 w-8 rounded-full border-2 ${
                  node.tone === "brand"
                    ? "border-[color:var(--primary)] text-[color:var(--primary)] bg-[color:var(--primary)]/6"
                    : "border-slate-300 text-slate-400 bg-white"
                }`}>
                <node.icon size={15} strokeWidth={2.4} />
              </span>
              <span
                className="text-[9px] uppercase tracking-[0.12em] text-slate-500 text-center leading-tight"
                style={{ fontFamily: MONO }}>
                {node.label}
              </span>
            </div>

            {i < nodes.length - 1 && (
              <div className="flex-1 pt-4 px-1">
                <div className="relative h-px">
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(to right, rgba(15,23,42,0.22) 0 4px, transparent 4px 9px)",
                    }}
                  />
                  {i === 0 && (
                    <motion.div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        background: "var(--primary)",
                        height: 2,
                        top: -0.5,
                      }}
                      initial={reduce ? false : { width: 0 }}
                      animate={{ width: "100%" }}
                      transition={{
                        duration: 0.7,
                        ease: [0.22, 1, 0.36, 1],
                        delay: 0.15,
                      }}
                    />
                  )}
                </div>
                <p
                  className={`mt-2 text-[9px] uppercase tracking-[0.12em] text-center ${
                    i === 0
                      ? "text-[color:var(--primary)] font-bold"
                      : "text-slate-400"
                  }`}
                  style={{ fontFamily: MONO }}>
                  {i === 0 ? "Our rider" : "The courier"}
                </p>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

/**
 * How long a saved draft stays worth restoring. Matches the backend's
 * resumable-booking window (PARCEL_RESUMABLE_BOOKING_WINDOW_MS) so a
 * restored form and a resumed unpaid gateway order agree on the same
 * "recent enough" cutoff.
 */
const OUTSTATION_DRAFT_TTL_MS = 60 * 60 * 1000;

/**
 * Everything the customer typed, restored after an accidental refresh.
 *
 * This is the longest booking form in the app — sender details, courier,
 * destination, package, pickup window — and a refresh used to wipe all of
 * it and drop the customer back at step 0. Config-derived fields (max
 * weight, express charge, the zone-filtered courier list) are deliberately
 * NOT restored from here; those are re-fetched fresh on mount, since a
 * stale copy could silently disagree with a rate-card change an admin made
 * in the meantime.
 */
function loadOutstationBookingDraft() {
  return (
    getJSON(STORAGE_KEYS.PORTER_OUTSTATION_BOOKING_DRAFT, null, { storage: "session" }) || {}
  );
}

const ParcelDeliveryPage = () => {
  const { user } = useAuth();
  const outstationDraft = loadOutstationBookingDraft();
  const { settings } = useSettings();
  const appName = settings?.appName || "App";
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [loading, setLoading] = useState(false);
  // Wallet balance, for the "Pay from wallet" option. null until loaded.
  const [walletBalance, setWalletBalance] = useState(null);

  useEffect(() => {
    let cancelled = false;
    customerApi
      .getWalletSummary()
      .then((res) => {
        if (!cancelled) setWalletBalance(Number(res.data?.result?.balance) || 0);
      })
      .catch(() => {
        if (!cancelled) setWalletBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Form State
  const [pickupDetails, setPickupDetails] = useState(() => ({
    name: user?.name || "",
    phone: user?.phone || "",
    address: "",
    landmark: "",
    city: "",
    state: "",
    pincode: "",
    fullAddress: "",
    lat: null,
    lng: null,
    ...outstationDraft.pickupDetails,
  }));

  const composePickupFullAddress = (details) =>
    [
      details.address?.trim(),
      details.landmark?.trim() ? `Near ${details.landmark.trim()}` : "",
      details.city?.trim(),
      details.state?.trim(),
      details.pincode?.trim(),
    ]
      .filter(Boolean)
      .join(", ");

  const updatePickupField = (field, value) => {
    setPickupDetails((prev) => {
      const next = { ...prev, [field]: value };
      next.fullAddress = composePickupFullAddress(next);
      return next;
    });
  };

  /**
   * Who the parcel is actually for, once the courier company takes it
   * onward from our rider.
   *
   * Separate from `pickupDetails` and unrelated to `dropAddress` (which is
   * just a label for the courier company's counter our rider drops it at —
   * see createParcel). No map pin: nobody dispatches against this point, it
   * only has to be readable enough to label the parcel for the courier.
   */
  const [receiverDetails, setReceiverDetails] = useState(() => ({
    name: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    pincode: "",
    ...outstationDraft.receiverDetails,
  }));

  const updateReceiverField = (field, value) => {
    setReceiverDetails((prev) => ({ ...prev, [field]: value }));
  };

  const composeReceiverFullAddress = (details) =>
    [details.address?.trim(), details.city?.trim(), details.state?.trim(), details.pincode?.trim()]
      .filter(Boolean)
      .join(", ");

  // Admin-set cap from the booking config. 50 is only the pre-load fallback;
  // the server enforces the real value on every quote and booking.
  const [maxWeightKg, setMaxWeightKg] = useState(50);
  const [expressCharge, setExpressCharge] = useState(0);
  const [packageDescriptionPlaceholder, setPackageDescriptionPlaceholder] =
    useState("E.g. keys, critical document papers...");
  const [packageCategories, setPackageCategories] = useState([]);
  const [packageSegment, setPackageSegment] = useState(outstationDraft.packageSegment || ""); // 'personal' | 'business'
  const [packageCategory, setPackageCategory] = useState(outstationDraft.packageCategory || "");
  /** Display value only — do not clamp while typing so whole numbers work. */
  const [weightInput, setWeightInput] = useState(outstationDraft.weightInput || "0.2");
  const [weightUnit, setWeightUnit] = useState(outstationDraft.weightUnit || "kg"); // 'kg' | 'gm'
  const [description, setDescription] = useState(outstationDraft.description || "");
  const [deliverySpeed, setDeliverySpeed] = useState(outstationDraft.deliverySpeed || "normal");
  // No default — Cash silently pre-selected meant the "Request pickup" button
  // could be tapped without the customer ever consciously choosing how to
  // pay. Left blank until they pick one on the Pay step.
  const [paymentMethod, setPaymentMethod] = useState(outstationDraft.paymentMethod || "");
  const [courierCompanies, setCourierCompanies] = useState(
    FALLBACK_COURIER_COMPANIES,
  );
  const [courierCompanyId, setCourierCompanyId] = useState(outstationDraft.courierCompanyId || "");
  const [customCourierName, setCustomCourierName] = useState(outstationDraft.customCourierName || "");
  const [customCourierNameSaved, setCustomCourierNameSaved] = useState(
    Boolean(outstationDraft.customCourierNameSaved),
  );
  const [destinationCity, setDestinationCity] = useState(outstationDraft.destinationCity || "");
  const [courierLoading, setCourierLoading] = useState(false);
  const [zones, setZones] = useState([]);
  const [bookingDurationMode, setBookingDurationMode] = useState(
    outstationDraft.bookingDurationMode || "one_day",
  );
  const [customDaysInput, setCustomDaysInput] = useState(outstationDraft.customDaysInput || "7");
  const [preferredPickupDate, setPreferredPickupDate] = useState(
    outstationDraft.preferredPickupDate || todayDateInputValue(),
  );
  const [pickupTimeInput, setPickupTimeInput] = useState(outstationDraft.pickupTimeInput || "");

  // Waybill step state. Steps are navigable, not gated — tapping a node always
  // works; validation still runs on Continue and again on submit.
  const [step, setStep] = useState(outstationDraft.step || 0);
  const [furthest, setFurthest] = useState(outstationDraft.furthest || 0);

  // Autosave the draft on every change, so a refresh at any step restores
  // exactly where the customer left off instead of dropping them back to
  // step 0 with everything cleared.
  useEffect(() => {
    setJSON(
      STORAGE_KEYS.PORTER_OUTSTATION_BOOKING_DRAFT,
      {
        pickupDetails,
        receiverDetails,
        packageSegment,
        packageCategory,
        weightInput,
        weightUnit,
        description,
        deliverySpeed,
        paymentMethod,
        courierCompanyId,
        customCourierName,
        customCourierNameSaved,
        destinationCity,
        bookingDurationMode,
        customDaysInput,
        preferredPickupDate,
        step,
        furthest,
      },
      { storage: "session", ttlMs: OUTSTATION_DRAFT_TTL_MS },
    );
  }, [
    pickupDetails,
    packageSegment,
    packageCategory,
    weightInput,
    weightUnit,
    description,
    deliverySpeed,
    paymentMethod,
    courierCompanyId,
    customCourierName,
    customCourierNameSaved,
    destinationCity,
    bookingDurationMode,
    customDaysInput,
    preferredPickupDate,
    step,
    furthest,
    receiverDetails,
  ]);
  const [direction, setDirection] = useState(1);
  const topRef = useRef(null);

  const goToStep = useCallback((next) => {
    setStep((prev) => {
      if (next === prev) return prev;
      setDirection(next > prev ? 1 : -1);
      setFurthest((f) => Math.max(f, next));
      return next;
    });
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const bookingDurationParams = useMemo(
    () =>
      resolveBookingDurationParams(bookingDurationMode, {
        customDaysInput,
        preferredPickupDate,
      }),
    [bookingDurationMode, customDaysInput, preferredPickupDate],
  );

  const selectedBookingMode = useMemo(
    () =>
      BOOKING_DURATION_MODES.find((m) => m.value === bookingDurationMode) ||
      BOOKING_DURATION_MODES[0],
    [bookingDurationMode],
  );

  const parsedCustomDays = useMemo(() => {
    const n = parseInt(String(customDaysInput).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }, [customDaysInput]);

  const handleBookingDurationChange = (value) => {
    setBookingDurationMode(value);
    if (value === "one_day") {
      setPreferredPickupDate(todayDateInputValue());
    } else if (
      value === "by_date" &&
      (!preferredPickupDate || preferredPickupDate < todayDateInputValue())
    ) {
      setPreferredPickupDate(todayDateInputValue());
    }
  };

  // Destination city is never picked separately — it mirrors whatever city
  // the customer types into the receiver's address below, so they only ever
  // enter a city once and the two can never disagree.
  useEffect(() => {
    const city = receiverDetails.city?.trim();
    if (city && city !== destinationCity) setDestinationCity(city);
  }, [receiverDetails.city, destinationCity]);

  const selectedCourier = useMemo(
    () =>
      courierCompanies.find(
        (c) =>
          (c.id && c.id === courierCompanyId) || c.name === courierCompanyId,
      ) || null,
    [courierCompanies, courierCompanyId],
  );

  const isOtherCourier = selectedCourier?.isOther === true;

  useEffect(() => {
    if (!isOtherCourier) {
      setCustomCourierName("");
      setCustomCourierNameSaved(false);
    }
  }, [courierCompanyId, isOtherCourier]);

  // The courier dropdown is filtered to whichever companies actually cover
  // the customer's own pickup zone — a company that doesn't serve this area
  // can't be handed the parcel, so it shouldn't be offered at all. Falls
  // back to the unfiltered FALLBACK_COURIER_COMPANIES list while loading or
  // if the lookup fails.
  useEffect(() => {
    const lat = Number(pickupDetails.lat);
    const lng = Number(pickupDetails.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    let cancelled = false;
    setCourierLoading(true);
    parcelApi
      .getCouriersForLocation(lat, lng)
      .then((res) => {
        if (cancelled || !res.data?.success) return;
        const list = res.data.results || res.data.result || [];
        setCourierCompanies(
          list.map((c) => ({
            id: String(c.id || c._id || ""),
            name: c.name,
            phone: c.phone || "",
            isOther: c.isOther === true,
          })),
        );
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCourierLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pickupDetails.lat, pickupDetails.lng]);

  // Fetched once — outstation pickup has to resolve into one of these zones
  // (see createParcel's zone gate), checked here client-side too so the
  // customer finds out before submitting rather than from a 400.
  useEffect(() => {
    zonesApi
      .getActiveZones()
      .then((res) => setZones(res.data?.results || []))
      .catch(() => {});
  }, []);

  const pickupOutOfZone = useMemo(() => {
    if (!zones.length) return false;
    const lat = Number(pickupDetails.lat);
    const lng = Number(pickupDetails.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return zonesContainingPoint(zones, lat, lng).length === 0;
  }, [zones, pickupDetails.lat, pickupDetails.lng]);

  const saveCustomCourierName = useCallback(() => {
    const name = customCourierName.trim();
    if (!name) {
      toast.error("Enter the courier company name");
      return false;
    }
    setCustomCourierName(name);
    setCustomCourierNameSaved(true);
    return true;
  }, [customCourierName]);

  // For the "Other" option, the shipping company name is what the customer types.
  const courierCompany = isOtherCourier
    ? customCourierNameSaved
      ? customCourierName.trim()
      : ""
    : selectedCourier?.name || "";

  // Fare Estimation
  const weightKg = useMemo(() => {
    const n = parseFloat(String(weightInput).trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    const kg = weightUnit === "gm" ? n / 1000 : n;
    return Math.round((kg + Number.EPSILON) * 1000) / 1000;
  }, [weightInput, weightUnit]);

  // Segments available (only those that actually have active categories).
  const availableSegments = useMemo(() => {
    const set = new Set(
      (packageCategories || []).map((c) =>
        c.segment === "business" ? "business" : "personal",
      ),
    );
    return [
      { value: "personal", label: "Personal" },
      { value: "business", label: "Business" },
    ].filter((s) => set.has(s.value));
  }, [packageCategories]);

  // Categories that belong to the currently selected segment.
  const segmentCategories = useMemo(() => {
    if (!packageSegment) return [];
    return (packageCategories || []).filter(
      (c) =>
        (c.segment === "business" ? "business" : "personal") === packageSegment,
    );
  }, [packageCategories, packageSegment]);

  // Fare Estimation
  const [fareEstimation, setFareEstimation] = useState(null);
  const [estimating, setEstimating] = useState(false);
  // Persists past the toast so "why is Confirm disabled" stays answered on
  // screen — e.g. this courier doesn't ship the chosen route.
  const [fareError, setFareError] = useState(null);
  // Bumped on city-field blur to re-check the fare — typing "i", "in",
  // "ind"... must not each fire a request; only the finished value should.
  const [cityCheckTick, setCityCheckTick] = useState(0);

  // Receiver's city is a dropdown, not free text — restricted to whatever
  // destination cities the admin has actually priced for this pickup city +
  // courier (see backend ParcelCityRate), so the customer can never pick a
  // combo the booking would later reject as "service not available".
  const [destinationCityOptions, setDestinationCityOptions] = useState([]);
  const [destinationCityLoading, setDestinationCityLoading] = useState(false);

  // Re-fetch the receiver-city dropdown options whenever the pickup city or
  // chosen courier changes. Debounced on pickupDetails.city directly rather
  // than waiting for the input's blur event — relying on blur meant a
  // pickup city typed and left in place without ever losing focus (browser
  // autofill, tapping "Continue" straight from the field, a resumed draft)
  // left this dropdown stuck on "No priced cities yet" forever, even though
  // the city was right there and the backend had the routes priced.
  useEffect(() => {
    const originCity = pickupDetails.city?.trim();
    if (!originCity || !courierCompanyId) {
      setDestinationCityOptions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setDestinationCityLoading(true);
      parcelApi
        .getCityRateDestinations(originCity, courierCompanyId)
        .then((res) => {
          if (cancelled || !res.data?.success) return;
          const raw = res.data.results || res.data.result || [];
          const list = Array.isArray(raw) ? raw : [];
          setDestinationCityOptions(list);
          if (list.length && receiverDetails.city && !list.includes(receiverDetails.city)) {
            updateReceiverField("city", "");
          }
        })
        .catch(() => {
          if (!cancelled) setDestinationCityOptions([]);
        })
        .finally(() => {
          if (!cancelled) setDestinationCityLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupDetails.city, courierCompanyId]);

  // Coupon
  const [availableCoupons, setAvailableCoupons] = useState([]);
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponError, setCouponError] = useState(null);
  const [applyingCoupon, setApplyingCoupon] = useState(false);

  // Map Selection states
  const [mapPickerTarget, setMapPickerTarget] = useState(null); // 'pickup' only

  const fetchBookingConfig = useCallback(async () => {
    try {
      const response = await parcelApi.getBookingConfig();
      if (!response.data?.success) return;
      const cfg = response.data.result || {};
      const categories = Array.isArray(cfg.packageCategories)
        ? cfg.packageCategories
        : [];
      setPackageCategories(categories);
      // Courier companies are no longer set from the unfiltered booking
      // config — they're fetched zone-filtered against the pickup point
      // instead (see the getCouriersForLocation effect above).
      if (Number(cfg.maxWeightKg) > 0) setMaxWeightKg(Number(cfg.maxWeightKg));
    } catch (error) {
      console.error("Failed to load courier booking config", error);
    }
  }, []);

  useEffect(() => {
    fetchBookingConfig();
  }, [fetchBookingConfig]);

  // Keep selected category consistent with the chosen segment.
  useEffect(() => {
    if (!packageSegment) {
      if (packageCategory) setPackageCategory("");
      return;
    }
    if (!segmentCategories.some((c) => c.value === packageCategory)) {
      setPackageCategory(segmentCategories[0]?.value || "");
    }
  }, [packageSegment, segmentCategories, packageCategory]);

  // Handle Fare Calculation when pickup, weight, courier, or booking duration change
  useEffect(() => {
    const calcFare = async () => {
      if (isOtherCourier && !customCourierNameSaved) {
        setFareEstimation(null);
        return;
      }
      if (
        bookingDurationMode === "custom_days" &&
        (parsedCustomDays < 2 || parsedCustomDays > MAX_BOOKING_DAYS)
      ) {
        setFareEstimation(null);
        return;
      }
      if (
        pickupDetails.lat &&
        pickupDetails.lng &&
        pickupDetails.city?.trim() &&
        destinationCity &&
        weightKg > 0
      ) {
        setEstimating(true);
        try {
          const res = await parcelApi.calculateFare({
            pickupLat: pickupDetails.lat,
            pickupLng: pickupDetails.lng,
            // The courier's city-to-city charge is looked up from these two —
            // sent so the quote resolves the exact same way the booking below
            // does; without them the two can price (or refuse) differently.
            pickupCity: pickupDetails.city,
            destinationCity,
            parcelType: "outstation",
            weight: weightKg,
            courierCompanyId: selectedCourier?.id || undefined,
            courierCompany: selectedCourier?.name || undefined,
            pickupWindow: bookingDurationParams.pickupWindow,
            pickupWindowDays: bookingDurationParams.pickupWindowDays,
            preferredPickupDate: bookingDurationParams.preferredPickupDate,
            pickupTime: bookingDurationParams.pickupTime,
            deliverySpeed,
          });
          if (res.data && res.data.success) {
            const result = res.data.result || {};
            setFareEstimation(result);
            setFareError(null);
            if (result.configuredExpressCharge != null) {
              setExpressCharge(
                Math.max(0, Number(result.configuredExpressCharge) || 0),
              );
            }
          }
        } catch (error) {
          const msg =
            error?.response?.data?.message ||
            error?.message ||
            "Failed to calculate fare";
          toast.error(msg);
          setFareEstimation(null);
          setFareError(msg);
        } finally {
          setEstimating(false);
        }
      } else {
        setFareEstimation(null);
        setFareError(null);
      }
    };

    const delayDebounce = setTimeout(calcFare, 500);
    return () => clearTimeout(delayDebounce);
  }, [
    pickupDetails.lat,
    pickupDetails.lng,
    // Not pickupDetails.city/destinationCity directly — those are free-typed
    // text; re-checking on every keystroke fired a request per partial city
    // name. cityCheckTick bumps on blur instead (see the two city inputs).
    cityCheckTick,
    weightKg,
    selectedCourier?.id,
    selectedCourier?.name,
    isOtherCourier,
    customCourierNameSaved,
    bookingDurationParams.pickupWindow,
    bookingDurationParams.pickupWindowDays,
    bookingDurationParams.preferredPickupDate,
    bookingDurationMode,
    parsedCustomDays,
    deliverySpeed,
  ]);

  // Offers surfaced once the fare is known; a stale applied coupon (fare
  // recomputed after the customer changed weight/route) is cleared rather
  // than silently kept against a number it was never validated for.
  useEffect(() => {
    setAppliedCoupon(null);
    setCouponError(null);
    if (!fareEstimation?.fare) {
      setAvailableCoupons([]);
      return;
    }
    (async () => {
      try {
        const res = await parcelApi.getAvailableCoupons({
          fare: fareEstimation.fare,
          parcelType: "outstation",
        });
        setAvailableCoupons(res.data?.result || res.data?.results || []);
      } catch {
        setAvailableCoupons([]);
      }
    })();
  }, [fareEstimation?.fare]);

  const applyCoupon = async (code) => {
    const value = String(code || couponCode || "").trim().toUpperCase();
    if (!value || !pickupDetails.lat || !pickupDetails.lng) return;
    setApplyingCoupon(true);
    setCouponError(null);
    try {
      const res = await parcelApi.validateCoupon({
        pickupLat: pickupDetails.lat,
        pickupLng: pickupDetails.lng,
        pickupCity: pickupDetails.city,
        destinationCity,
        parcelType: "outstation",
        weight: weightKg,
        courierCompanyId: selectedCourier?.id || undefined,
        courierCompany: selectedCourier?.name || undefined,
        pickupWindow: bookingDurationParams.pickupWindow,
        pickupWindowDays: bookingDurationParams.pickupWindowDays,
        preferredPickupDate: bookingDurationParams.preferredPickupDate,
        pickupTime: bookingDurationParams.pickupTime,
        deliverySpeed,
        couponCode: value,
      });
      setAppliedCoupon(res.data?.result || null);
      setCouponCode(value);
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err?.response?.data?.message || "Couldn't apply this coupon");
    } finally {
      setApplyingCoupon(false);
    }
  };

  const removeCoupon = () => {
    setAppliedCoupon(null);
    setCouponCode("");
    setCouponError(null);
  };

  // Map Selection Confirmation
  const handleMapConfirm = (location) => {
    if (mapPickerTarget === "pickup") {
      setPickupDetails((prev) => {
        const next = {
          ...prev,
          address: location.locality || prev.address || location.address || "",
          city: location.city || prev.city || "",
          state: location.state || prev.state || "",
          pincode: location.pincode || prev.pincode || "",
          lat: location.lat,
          lng: location.lng,
        };
        // If street line is empty, fall back to full formatted address from map
        if (!next.address?.trim() && location.address) {
          next.address = location.address;
        }
        next.fullAddress =
          composePickupFullAddress(next) || location.address || "";
        return next;
      });
      toast.success("Pickup point set");
    }
    setMapPickerTarget(null);
  };

  /**
   * Per-step gate. Same rules and wording as the final submit check, just
   * surfaced next to the fields that can still be fixed.
   */
  const validateStep = useCallback(
    (index) => {
      if (index === 0) {
        // Rules match the server so the customer is stopped here rather
        // than after a round trip. A trim()-only gate used to accept
        // "12345" as a name and "abc" as the phone a rider has to call.
        const problem = firstProblem(
          checkPersonName(pickupDetails.name, "Sender name"),
          checkPhone(pickupDetails.phone, "Sender phone"),
          checkAddressLine(pickupDetails.address, "House / street address"),
          checkPlaceName(pickupDetails.city, "City"),
          checkPlaceName(pickupDetails.state, "State"),
          checkPincode(pickupDetails.pincode),
        );
        if (problem) return problem;
        if (!pickupDetails.lat || !pickupDetails.lng)
          return "Set the pickup point on the map.";
        // Gated here, not just at final submit — the customer should not be
        // able to fill out courier/package/payment for a pickup that was
        // never bookable, only to be turned away at the very last step.
        if (pickupOutOfZone)
          return "Pickup location is outside our serviceable zones. Please choose a pickup point inside a serviceable zone.";
        return null;
      }
      if (index === 1) {
        if (!selectedCourier) return "Pick a courier company.";
        if (isOtherCourier && !customCourierNameSaved)
          return "Enter the courier company name, then press Enter.";
        if (
          bookingDurationMode === "custom_days" &&
          (parsedCustomDays < 2 || parsedCustomDays > MAX_BOOKING_DAYS)
        )
          return `Enter between 2 and ${MAX_BOOKING_DAYS} days.`;
        if (bookingDurationMode === "by_date") {
          const problem = pickupScheduleProblem(preferredPickupDate, pickupTimeInput);
          if (problem) return problem;
        }
        const receiverProblem = firstProblem(
          checkPersonName(receiverDetails.name, "Receiver name"),
          checkPhone(receiverDetails.phone, "Receiver phone"),
          checkAddressLine(receiverDetails.address, "Receiver address"),
          checkPlaceName(receiverDetails.city, "Receiver city"),
          checkPlaceName(receiverDetails.state, "Receiver state"),
          checkPincode(receiverDetails.pincode),
        );
        if (receiverProblem) return receiverProblem;
        return null;
      }
      if (index === 2) {
        if (weightKg <= 0 || weightKg > maxWeightKg)
          return `Weight must be between 0 and ${maxWeightKg} KG (or up to ${Math.round(maxWeightKg * 1000)} gm).`;
        return null;
      }
      return null;
    },
    [
      pickupDetails,
      pickupOutOfZone,
      receiverDetails,
      selectedCourier,
      isOtherCourier,
      customCourierNameSaved,
      bookingDurationMode,
      parsedCustomDays,
      preferredPickupDate,
      weightKg,
      maxWeightKg,
    ],
  );

  const handleContinue = () => {
    const problem = validateStep(step);
    if (problem) {
      toast.error(problem);
      return;
    }
    goToStep(Math.min(step + 1, STEPS.length - 1));
  };

  /** Drives the barcode: it is only complete when the waybill is. */
  const completion = useMemo(() => {
    const checks = [
      Boolean(pickupDetails.name?.trim()),
      Boolean(pickupDetails.phone?.trim()),
      Boolean(pickupDetails.address?.trim()),
      Boolean(pickupDetails.city?.trim()),
      Boolean(pickupDetails.state?.trim()),
      Boolean(pickupDetails.pincode?.trim()),
      Boolean(pickupDetails.lat && pickupDetails.lng),
      Boolean(selectedCourier && (!isOtherCourier || customCourierNameSaved)),
      Boolean(destinationCity),
      validateStep(1) === null,
      weightKg > 0 && weightKg <= maxWeightKg,
      Boolean(fareEstimation),
    ];
    return checks.filter(Boolean).length / checks.length;
  }, [
    pickupDetails,
    selectedCourier,
    isOtherCourier,
    customCourierNameSaved,
    destinationCity,
    validateStep,
    weightKg,
    maxWeightKg,
    fareEstimation,
  ]);

  // Whether the customer has actually confirmed the booking in the dialog
  // below — the submit button alone used to be enough to book instantly
  // (especially for COD, which has no Razorpay screen to act as a natural
  // "are you sure" gate), and it read exactly like every other "Continue"
  // button in the wizard, so an unintended tap silently placed a real order.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Validates the whole form and, if it's bookable, opens the confirm
  // dialog — it does not book anything by itself.
  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    const composedAddress = composePickupFullAddress(pickupDetails);
    if (!pickupDetails.address?.trim()) {
      return toast.error("Please enter house / street address.");
    }
    if (!pickupDetails.city?.trim()) {
      return toast.error("Please enter city.");
    }
    if (!pickupDetails.state?.trim()) {
      return toast.error("Please enter state.");
    }
    if (!pickupDetails.pincode?.trim()) {
      return toast.error("Please enter pincode.");
    }
    if (!pickupDetails.lat || !pickupDetails.lng) {
      return toast.error("Please select pickup location on the map.");
    }
    if (pickupOutOfZone) {
      return toast.error(
        "Pickup location is outside our serviceable zones. Please choose a pickup point inside a serviceable zone.",
      );
    }
    if (!pickupDetails.name || !pickupDetails.phone) {
      return toast.error("Please enter sender details.");
    }
    if (weightKg <= 0 || weightKg > maxWeightKg) {
      return toast.error(
        `Weight must be between 0 and ${maxWeightKg} KG (or up to ${Math.round(maxWeightKg * 1000)} gm).`,
      );
    }
    if (!selectedCourier) {
      return toast.error("Please select a courier company.");
    }
    if (isOtherCourier && !customCourierNameSaved) {
      return toast.error("Please enter courier company name and press Enter.");
    }
    if (estimating) {
      return toast.error("Checking price for this route, please wait.");
    }
    if (!fareEstimation?.fare) {
      return toast.error(
        fareError ||
          "This courier doesn't ship between the selected cities. Choose a different courier or destination.",
      );
    }
    if (!receiverDetails.name?.trim() || !receiverDetails.phone?.trim()) {
      return toast.error("Please enter receiver name and phone.");
    }
    if (!receiverDetails.address?.trim()) {
      return toast.error("Please enter receiver address.");
    }
    if (!receiverDetails.city?.trim() || !receiverDetails.state?.trim()) {
      return toast.error("Please enter receiver city and state.");
    }
    if (!receiverDetails.pincode?.trim()) {
      return toast.error("Please enter receiver pincode.");
    }
    if (bookingDurationMode === "custom_days") {
      if (parsedCustomDays < 2 || parsedCustomDays > MAX_BOOKING_DAYS) {
        return toast.error(`Enter between 2 and ${MAX_BOOKING_DAYS} days.`);
      }
    }
    if (bookingDurationMode === "by_date") {
      const problem = pickupScheduleProblem(preferredPickupDate, pickupTimeInput);
      if (problem) return toast.error(problem);
    }

    if (paymentMethod === "WALLET") {
      const payable = Number(appliedCoupon?.payableFare ?? fareEstimation?.fare) || 0;
      if (walletBalance != null && walletBalance + 0.0001 < payable) {
        return toast.error(
          "Your wallet balance is not enough for this booking. Add money to your wallet first.",
        );
      }
    }

    setConfirmOpen(true);
  };

  // The actual booking — only ever called from the confirm dialog's own
  // "Confirm" button, never from handlePlaceOrder directly.
  const confirmAndBook = async () => {
    setConfirmOpen(false);
    const composedAddress = composePickupFullAddress(pickupDetails);
    // The rider now personally carries the parcel to the chosen courier
    // company's counter and drops it there (with photo proof) — there is no
    // warehouse hop anymore. The drop record is just a label for that
    // counter; nobody dispatches against its lat/lng, so it defaults to the
    // pickup point as a placeholder.
    const dropAddress = {
      name: courierCompany,
      phone:
        String(selectedCourier?.phone || pickupDetails.phone || "")
          .replace(/\D/g, "")
          .slice(-10) || "0000000000",
      fullAddress: selectedCourier?.isOther
        ? `${courierCompany} drop point, ${destinationCity}`
        : courierCompany,
      lat: pickupDetails.lat ?? 0,
      lng: pickupDetails.lng ?? 0,
    };

    const resolvedPickupDate = bookingDurationParams.preferredPickupDate;

    setLoading(true);
    try {
      const response = await parcelApi.createParcel({
        pickupAddress: {
          name: pickupDetails.name,
          phone: pickupDetails.phone,
          fullAddress: composedAddress,
          lat: pickupDetails.lat,
          lng: pickupDetails.lng,
          pincode: pickupDetails.pincode?.trim() || undefined,
          // Matched against the admin's courier city-to-city rate card.
          city: pickupDetails.city?.trim(),
        },
        dropAddress,
        receiverAddress: {
          name: receiverDetails.name.trim(),
          phone: receiverDetails.phone.trim(),
          fullAddress: composeReceiverFullAddress(receiverDetails),
          city: receiverDetails.city.trim(),
          state: receiverDetails.state.trim(),
          pincode: receiverDetails.pincode.trim(),
        },
        packageDetails: {
          packageType: DEFAULT_PACKAGE_TYPE,
          packageSegment,
          packageCategory,
          weight: weightKg,
          description,
        },
        courierCompany,
        courierCompanyId: selectedCourier.id || undefined,
        customCourierName: isOtherCourier
          ? customCourierName.trim()
          : undefined,
        destinationCity,
        parcelType: "outstation",
        pickupWindow: bookingDurationParams.pickupWindow,
        pickupWindowDays: bookingDurationParams.pickupWindowDays,
        preferredPickupDate: resolvedPickupDate,
        deliverySpeed,
        paymentMethod,
        couponCode: appliedCoupon?.code || undefined,
      });

      if (response.data && response.data.success) {
        const payload = response.data.result || {};
        const createdParcel = payload.parcel || payload;
        const razorpay = payload.razorpay;
        const needsPayment = Boolean(
          payload.requiresPayment && razorpay?.orderId,
        );

        if (needsPayment) {
          try {
            const paymentResult = await openParcelRazorpayCheckout({
              keyId: razorpay.keyId,
              orderId: razorpay.orderId,
              amount: razorpay.amount,
              currency: razorpay.currency || "INR",
              name: appName,
              description: `Courier delivery · ₹${createdParcel.fare}`,
              prefill: {
                name: pickupDetails.name || user?.name || "",
                email: user?.email || "",
                contact: pickupDetails.phone || user?.phone || "",
              },
            });

            const verifyRes = await parcelApi.verifyParcelPayment({
              parcelId: createdParcel._id,
              ...paymentResult,
            });

            if (!verifyRes.data?.success) {
              throw new Error(
                verifyRes.data?.message || "Payment verification failed",
              );
            }

            toast.success("Payment received. Finding a rider nearby...");
            const paidParcel = verifyRes.data.result?.parcel || createdParcel;
            navigate(`/parcel/search/${paidParcel._id}`);
          } catch (payError) {
            if (payError?.message === "Payment cancelled") {
              toast.info(
                "Payment cancelled. You can retry from courier history.",
              );
            } else {
              toast.error(
                payError?.response?.data?.message ||
                  payError?.message ||
                  "Payment failed. Please try again.",
              );
            }
            return;
          }
        } else {
          toast.success(
            paymentMethod === "WALLET"
              ? "Paid from your wallet. Finding a rider nearby..."
              : "Pickup requested. Finding a rider nearby...",
          );
          navigate(`/parcel/search/${createdParcel._id}`);
        }
        if (paymentMethod === "WALLET") {
          customerApi
            .getWalletSummary()
            .then((res) => setWalletBalance(Number(res.data?.result?.balance) || 0))
            .catch(() => {});
        }

        // Reset form after successful book / paid UPI
        setDescription("");
        setPackageSegment("");
        setPackageCategory("");
        setCourierCompanyId("");
        setCustomCourierName("");
        setCustomCourierNameSaved(false);
        setDeliverySpeed("normal");
        setDestinationCity("");
        setReceiverDetails({ name: "", phone: "", address: "", city: "", state: "", pincode: "" });
        setBookingDurationMode("one_day");
        setCustomDaysInput("7");
        setPreferredPickupDate(todayDateInputValue());
        setWeightInput("0.2");
        setWeightUnit("kg");
        setFareEstimation(null);
        setStep(0);
        setFurthest(0);
        removeStored(STORAGE_KEYS.PORTER_OUTSTATION_BOOKING_DRAFT, { storage: "session" });
      } else {
        toast.error(response.data.message || "Failed to create request");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Booking failed");
    } finally {
      setLoading(false);
    }
  };

  const isLastStep = step === STEPS.length - 1;
  const submitBlocked =
    loading ||
    estimating ||
    !pickupDetails.lat ||
    !pickupDetails.city?.trim() ||
    !destinationCity ||
    !selectedCourier ||
    (isOtherCourier && !customCourierNameSaved) ||
    // No confirmed price (e.g. the courier doesn't ship this route — see
    // "service not available" from calculateFare) means nothing to book.
    !fareEstimation?.fare ||
    !paymentMethod;

  const totalFare = fareEstimation
    ? Number(appliedCoupon?.payableFare ?? fareEstimation.fare) || 0
    : 0;
  const walletShort =
    paymentMethod === "WALLET" &&
    walletBalance != null &&
    totalFare > 0 &&
    walletBalance + 0.0001 < totalFare;

  return (
    <div className="min-h-screen bg-slate-100 font-outfit">
      <div ref={topRef} className="mx-auto max-w-2xl px-4 pt-7 pb-10">
        {/* ── Masthead ─────────────────────────────────────────────────── */}
        <div className="mb-5">
          <Caption className="text-[color:var(--primary)]">
            Courier drop-off · up to {maxWeightKg} kg
          </Caption>
          <h1 className="text-[32px] leading-[1.05] font-black tracking-[-0.03em] text-slate-900 mt-2">
            Skip the courier
            <br />
            counter queue.
          </h1>
          <p className="text-[15px] text-slate-500 font-medium mt-3 max-w-md leading-relaxed">
            A rider collects your courier from your door and hands it to the
            courier company you choose. You fill this waybill once.
          </p>
        </div>

        {/* ── Waybill stub: route, draft barcode, running total ─────────── */}
        <Sheet className="overflow-hidden">
          <div className="px-5 pt-5 pb-4">
            <RouteRail
              steps={STEPS}
              current={step}
              furthest={furthest}
              onJump={goToStep}
            />
          </div>

          <TearLine tone="#F1F5F9" />

          <div className="px-5 pt-2 pb-5 flex items-end justify-between gap-5">
            <div className="min-w-0">
              <Caption>Draft waybill</Caption>
              <Barcode
                ratio={completion}
                seed="SUNGGUARD-PARCEL"
                bars={38}
                className="mt-2"
              />
            </div>
            <div className="text-right shrink-0">
              <Caption>{estimating ? "Pricing…" : "Estimate"}</Caption>
              <div
                className={`text-[26px] font-black tracking-[-0.03em] mt-1 tabular-nums transition-opacity duration-200 ${
                  estimating ? "opacity-40" : "opacity-100"
                } ${totalFare > 0 ? "text-slate-900" : "text-slate-300"}`}>
                <Money value={totalFare} />
              </div>
            </div>
          </div>
        </Sheet>

        {/* ── Steps ─────────────────────────────────────────────────────── */}
        <form
          onSubmit={handlePlaceOrder}
          onKeyDown={(e) => {
            // Enter inside a field must never submit the form — on every
            // step, including the last one. The submit button now only ever
            // opens the confirm dialog, never books directly, but a stray
            // Enter (mobile keyboard "Go", autofill, mis-focus) reaching the
            // form's onSubmit would still pop that dialog open unasked.
            // Booking is meant to start from one deliberate tap, nothing else.
            if (
              e.key === "Enter" &&
              e.target.tagName !== "TEXTAREA" &&
              e.target.tagName !== "BUTTON"
            ) {
              e.preventDefault();
            }
          }}>
          <div className="relative mt-4">
            <AnimatePresence mode="wait" initial={false}>
              <StepPane paneKey={STEPS[step].key} direction={direction}>
                <motion.div variants={stagger} initial="hidden" animate="show">
                  <div className="mb-3 px-1">
                    <h2 className="text-[19px] font-black tracking-[-0.02em] text-slate-900">
                      {STEPS[step].heading}
                    </h2>
                  </div>

                  {/* ── FROM ─────────────────────────────────────────── */}
                  {step === 0 && (
                    <div className="space-y-3">
                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="Sender"
                              filled={Boolean(pickupDetails.name?.trim())}>
                              <div className="relative">
                                <User
                                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                  size={15}
                                />
                                <input
                                  type="text"
                                  placeholder="Full name"
                                  value={pickupDetails.name}
                                  onChange={(e) =>
                                    setPickupDetails((p) => ({
                                      ...p,
                                      name: sanitizeNameInput(e.target.value),
                                    }))
                                  }
                                  maxLength={NAME_MAX}
                                  autoComplete="name"
                                  className={cn(
                                    inputClass(
                                      Boolean(pickupDetails.name?.trim()),
                                    ),
                                    "pl-10",
                                  )}
                                />
                              </div>
                            </Field>
                            <Field
                              label="Phone"
                              filled={Boolean(pickupDetails.phone?.trim())}>
                              <div className="relative">
                                <Phone
                                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                  size={15}
                                />
                                <input
                                  type="tel"
                                  inputMode="tel"
                                  placeholder="10-digit"
                                  value={pickupDetails.phone}
                                  onChange={(e) =>
                                    setPickupDetails((p) => ({
                                      ...p,
                                      phone: sanitizePhoneInput(e.target.value),
                                    }))
                                  }
                                  maxLength={PHONE_MAX}
                                  autoComplete="tel"
                                  className={cn(
                                    inputClass(
                                      Boolean(pickupDetails.phone?.trim()),
                                    ),
                                    "pl-10",
                                  )}
                                />
                              </div>
                            </Field>
                          </div>
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <Field
                            label="House / flat / street"
                            filled={Boolean(pickupDetails.address?.trim())}>
                            <textarea
                              rows={2}
                              placeholder="Flat no, building, street or area"
                              value={pickupDetails.address}
                              onChange={(e) =>
                                updatePickupField("address", e.target.value)
                              }
                              className={cn(
                                inputClass(
                                  Boolean(pickupDetails.address?.trim()),
                                ),
                                "resize-none",
                              )}
                            />
                          </Field>

                          <Field
                            label="Landmark"
                            hint="Optional, but riders find you faster with one."
                            filled={Boolean(pickupDetails.landmark?.trim())}>
                            <input
                              type="text"
                              placeholder="Near City Mall"
                              value={pickupDetails.landmark}
                              onChange={(e) =>
                                updatePickupField("landmark", e.target.value)
                              }
                              className={inputClass(
                                Boolean(pickupDetails.landmark?.trim()),
                              )}
                            />
                          </Field>

                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="City"
                              filled={Boolean(pickupDetails.city?.trim())}>
                              <input
                                type="text"
                                placeholder="City"
                                value={pickupDetails.city}
                                onChange={(e) =>
                                  updatePickupField("city", e.target.value)
                                }
                                onBlur={() => setCityCheckTick((t) => t + 1)}
                                className={inputClass(
                                  Boolean(pickupDetails.city?.trim()),
                                )}
                              />
                            </Field>
                            <Field
                              label="State"
                              filled={Boolean(pickupDetails.state?.trim())}>
                              <input
                                type="text"
                                placeholder="State"
                                value={pickupDetails.state}
                                onChange={(e) =>
                                  updatePickupField("state", e.target.value)
                                }
                                className={inputClass(
                                  Boolean(pickupDetails.state?.trim()),
                                )}
                              />
                            </Field>
                          </div>

                          <Field
                            label="Pincode"
                            filled={Boolean(pickupDetails.pincode?.trim())}>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              placeholder="110075"
                              value={pickupDetails.pincode}
                              onChange={(e) =>
                                updatePickupField(
                                  "pincode",
                                  e.target.value.replace(/\D/g, "").slice(0, 6),
                                )
                              }
                              className={cn(
                                inputClass(
                                  Boolean(pickupDetails.pincode?.trim()),
                                ),
                                "tracking-[0.25em]",
                              )}
                              style={{ fontFamily: MONO }}
                            />
                          </Field>
                        </Sheet>
                      </motion.div>

                      {/* Map pin — the one thing the fare cannot be computed without */}
                      <motion.div variants={stackItem}>
                        <button
                          type="button"
                          onClick={() => setMapPickerTarget("pickup")}
                          className={`w-full rounded-[26px] border-2 border-dashed p-4 flex items-center gap-3 text-left transition-colors ${
                            pickupDetails.lat
                              ? "border-[color:var(--primary)]/40 bg-[color-mix(in_srgb,var(--primary)_6%,white)]"
                              : "border-slate-300 bg-white hover:border-slate-400"
                          }`}>
                          <span
                            className={`grid place-items-center h-11 w-11 rounded-2xl shrink-0 ${
                              pickupDetails.lat
                                ? "bg-[color:var(--primary)] text-white"
                                : "bg-slate-100 text-slate-500"
                            }`}>
                            <MapPin size={19} strokeWidth={2.4} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-bold text-slate-900">
                              {pickupDetails.lat
                                ? "Pickup point set"
                                : "Drop a pin on the map"}
                            </span>
                            <span className="block text-[11px] text-slate-500 font-medium mt-0.5 truncate">
                              {pickupDetails.lat
                                ? `${Number(pickupDetails.lat).toFixed(4)}, ${Number(pickupDetails.lng).toFixed(4)}`
                                : "The fare needs an exact location"}
                            </span>
                          </span>
                          {pickupDetails.lat && (
                            <Check
                              size={18}
                              strokeWidth={3}
                              className="text-[color:var(--primary)] shrink-0"
                            />
                          )}
                        </button>
                      </motion.div>

                      {pickupOutOfZone && (
                        <motion.div variants={stackItem}>
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 flex items-start gap-2">
                            <span className="text-base leading-none">⚠️</span>
                            <span>
                              This pickup point is outside our serviceable zones. Please drop the
                              pin somewhere we currently deliver from.
                            </span>
                          </div>
                        </motion.div>
                      )}

                      <motion.div variants={stackItem}>
                        <ParcelReviewsSection />
                      </motion.div>
                    </div>
                  )}

                  {/* ── TO ───────────────────────────────────────────── */}
                  {step === 1 && (
                    <div className="space-y-3">
                      <motion.div variants={stackItem}>
                        <Sheet className="px-5 py-4">
                          <HandoffDiagram
                            counter={courierCompany}
                            destination={destinationCity}
                          />
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4 relative z-20">
                          <Field
                            label="Courier company"
                            filled={Boolean(selectedCourier)}
                            hint={
                              selectedCourier && !isOtherCourier
                                ? "Our rider will drop your courier here in person."
                                : courierLoading
                                  ? "Finding couriers that serve your area…"
                                  : "Whoever you normally post with."
                            }>
                            <CourierCompanySelect
                              companies={courierCompanies}
                              value={courierCompanyId}
                              onChange={setCourierCompanyId}
                            />
                          </Field>

                          <AnimatePresence initial={false}>
                            {isOtherCourier && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{
                                  type: "spring",
                                  stiffness: 400,
                                  damping: 34,
                                }}
                                className="overflow-hidden">
                                <Field
                                  label="Company name"
                                  filled={customCourierNameSaved}
                                  hint={
                                    customCourierNameSaved
                                      ? "Saved."
                                      : "Type the name, then press Enter to save it."
                                  }
                                  adornment={
                                    customCourierNameSaved ? (
                                      <span
                                        className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--primary)] font-bold"
                                        style={{ fontFamily: MONO }}>
                                        Saved
                                      </span>
                                    ) : null
                                  }>
                                  <div className="relative">
                                    <Building2
                                      className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                      size={15}
                                    />
                                    <input
                                      type="text"
                                      placeholder="Courier company name"
                                      value={customCourierName}
                                      onChange={(e) => {
                                        setCustomCourierName(e.target.value);
                                        setCustomCourierNameSaved(false);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key !== "Enter") return;
                                        e.preventDefault();
                                        if (saveCustomCourierName())
                                          e.currentTarget.blur();
                                      }}
                                      className={cn(
                                        inputClass(customCourierNameSaved),
                                        "pl-10",
                                      )}
                                    />
                                  </div>
                                </Field>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                            Receiver details
                          </p>
                          <p className="text-[11px] text-slate-400 -mt-2">
                            Who the courier hands this to. The city you enter below is also
                            used as the destination city.
                          </p>

                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="Receiver name"
                              filled={Boolean(receiverDetails.name?.trim())}>
                              <div className="relative">
                                <User
                                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                  size={15}
                                />
                                <input
                                  type="text"
                                  placeholder="Full name"
                                  value={receiverDetails.name}
                                  onChange={(e) =>
                                    updateReceiverField("name", sanitizeNameInput(e.target.value))
                                  }
                                  maxLength={NAME_MAX}
                                  autoComplete="name"
                                  className={cn(
                                    inputClass(Boolean(receiverDetails.name?.trim())),
                                    "pl-10",
                                  )}
                                />
                              </div>
                            </Field>
                            <Field
                              label="Receiver phone"
                              filled={Boolean(receiverDetails.phone?.trim())}>
                              <div className="relative">
                                <Phone
                                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                  size={15}
                                />
                                <input
                                  type="tel"
                                  inputMode="tel"
                                  placeholder="10-digit"
                                  value={receiverDetails.phone}
                                  onChange={(e) =>
                                    updateReceiverField("phone", sanitizePhoneInput(e.target.value))
                                  }
                                  maxLength={PHONE_MAX}
                                  autoComplete="tel"
                                  className={cn(
                                    inputClass(Boolean(receiverDetails.phone?.trim())),
                                    "pl-10",
                                  )}
                                />
                              </div>
                            </Field>
                          </div>

                          <Field
                            label="Receiver address"
                            filled={Boolean(receiverDetails.address?.trim())}>
                            <textarea
                              rows={2}
                              placeholder="Flat no, building, street or area"
                              value={receiverDetails.address}
                              onChange={(e) => updateReceiverField("address", e.target.value)}
                              className={cn(
                                inputClass(Boolean(receiverDetails.address?.trim())),
                                "resize-none",
                              )}
                            />
                          </Field>

                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="City"
                              hint={
                                !pickupDetails.city?.trim() || !courierCompanyId
                                  ? "Enter pickup city & pick a courier first"
                                  : undefined
                              }
                              filled={Boolean(receiverDetails.city?.trim())}>
                              <select
                                value={receiverDetails.city}
                                onChange={(e) => {
                                  updateReceiverField("city", e.target.value);
                                  setCityCheckTick((t) => t + 1);
                                }}
                                disabled={
                                  destinationCityLoading ||
                                  !pickupDetails.city?.trim() ||
                                  !courierCompanyId
                                }
                                className={inputClass(Boolean(receiverDetails.city?.trim()))}>
                                <option value="">
                                  {destinationCityLoading
                                    ? "Loading cities…"
                                    : destinationCityOptions.length === 0
                                      ? "No priced cities yet"
                                      : "Select city"}
                                </option>
                                {receiverDetails.city &&
                                  !destinationCityOptions.includes(receiverDetails.city) && (
                                    <option value={receiverDetails.city}>
                                      {receiverDetails.city}
                                    </option>
                                  )}
                                {destinationCityOptions.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field
                              label="State"
                              filled={Boolean(receiverDetails.state?.trim())}>
                              <input
                                type="text"
                                placeholder="State"
                                value={receiverDetails.state}
                                onChange={(e) => updateReceiverField("state", e.target.value)}
                                className={inputClass(Boolean(receiverDetails.state?.trim()))}
                              />
                            </Field>
                          </div>

                          <Field
                            label="Pincode"
                            filled={Boolean(receiverDetails.pincode?.trim())}>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              placeholder="110075"
                              value={receiverDetails.pincode}
                              onChange={(e) =>
                                updateReceiverField(
                                  "pincode",
                                  e.target.value.replace(/\D/g, "").slice(0, 6),
                                )
                              }
                              className={cn(
                                inputClass(Boolean(receiverDetails.pincode?.trim())),
                                "tracking-[0.25em]",
                              )}
                              style={{ fontFamily: MONO }}
                            />
                          </Field>
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <Field
                            label="Book pickup for"
                            hint={`${selectedBookingMode.helper}.`}>
                            <Segmented
                              name="duration"
                              columns={3}
                              options={BOOKING_DURATION_MODES}
                              value={bookingDurationMode}
                              onChange={handleBookingDurationChange}
                            />
                          </Field>

                          <AnimatePresence mode="wait" initial={false}>
                            {bookingDurationMode === "custom_days" && (
                              <motion.div
                                key="days"
                                initial={{ opacity: 0, y: -6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -6 }}
                                transition={{ duration: 0.18 }}>
                                <Field
                                  label="Number of days"
                                  hint={`A rider is available each day, up to ${MAX_BOOKING_DAYS}.`}
                                  filled={parsedCustomDays >= 2}>
                                  <input
                                    type="number"
                                    min={2}
                                    max={MAX_BOOKING_DAYS}
                                    step={1}
                                    value={customDaysInput}
                                    onChange={(e) =>
                                      setCustomDaysInput(
                                        e.target.value
                                          .replace(/\D/g, "")
                                          .slice(0, 2),
                                      )
                                    }
                                    placeholder={`2 to ${MAX_BOOKING_DAYS}`}
                                    className={inputClass(
                                      parsedCustomDays >= 2,
                                    )}
                                    style={{ fontFamily: MONO }}
                                  />
                                </Field>
                              </motion.div>
                            )}

                            {bookingDurationMode === "by_date" && (
                              <motion.div
                                key="date"
                                initial={{ opacity: 0, y: -6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -6 }}
                                transition={{ duration: 0.18 }}>
                                <Field
                                  label="Pickup date"
                                  hint="The date the rider should come for pickup."
                                  filled={Boolean(preferredPickupDate)}>
                                  <div className="relative">
                                    <CalendarDays
                                      className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                                      size={15}
                                    />
                                    <input
                                      type="date"
                                      min={todayDateInputValue()}
                                      max={addDaysToDateInput(MAX_BOOKING_DAYS)}
                                      value={preferredPickupDate}
                                      onChange={(e) =>
                                        setPreferredPickupDate(e.target.value)
                                      }
                                      className={cn(
                                        inputClass(
                                          Boolean(preferredPickupDate),
                                        ),
                                        "pl-10",
                                      )}
                                    />
                                  </div>
                                </Field>
                                <Field
                                  label="Pickup time"
                                  hint="The rider's request goes out at this time."
                                  filled={Boolean(pickupTimeInput)}>
                                  <input
                                    type="time"
                                    value={pickupTimeInput}
                                    onChange={(e) => setPickupTimeInput(e.target.value)}
                                    className={cn(inputClass(Boolean(pickupTimeInput)), "pl-3")}
                                  />
                                </Field>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          <div className="rounded-2xl bg-slate-50 border border-slate-100 px-4 py-3 flex items-start gap-2.5">
                            <Clock
                              className="text-[color:var(--primary)] shrink-0 mt-0.5"
                              size={14}
                            />
                            <p className="text-[12px] text-slate-600 font-medium leading-relaxed">
                              {bookingDurationMode === "one_day" && (
                                <>
                                  Pickup is available{" "}
                                  <span className="font-bold text-slate-900">
                                    today only
                                  </span>
                                  .
                                </>
                              )}
                              {bookingDurationMode === "custom_days" &&
                                parsedCustomDays >= 2 && (
                                  <>
                                    Daily pickup for{" "}
                                    <span className="font-bold text-slate-900">
                                      {parsedCustomDays} days
                                    </span>
                                    , through{" "}
                                    <span className="font-bold text-slate-900">
                                      {formatBookingDate(
                                        addDaysToDateInput(parsedCustomDays),
                                      )}
                                    </span>
                                    .
                                  </>
                                )}
                              {bookingDurationMode === "custom_days" &&
                                parsedCustomDays < 2 && (
                                  <>
                                    Enter how many days you want pickup for.
                                    Minimum is 2.
                                  </>
                                )}
                              {bookingDurationMode === "by_date" &&
                                preferredPickupDate && (
                                  <>
                                    Daily pickup through{" "}
                                    <span className="font-bold text-slate-900">
                                      {formatBookingDate(preferredPickupDate)}
                                    </span>
                                    .
                                  </>
                                )}
                            </p>
                          </div>
                        </Sheet>
                      </motion.div>
                    </div>
                  )}

                  {/* ── WHAT ─────────────────────────────────────────── */}
                  {step === 2 && (
                    <div className="space-y-3">
                      <motion.div variants={stackItem}>
                        <Sheet className="p-5">
                          <Field
                            label={`Weight · max ${weightUnit === "gm" ? `${Math.round(maxWeightKg * 1000)} gm` : `${maxWeightKg} kg`}`}
                            filled={weightKg > 0 && weightKg <= maxWeightKg}>
                            <div className="flex items-center gap-3">
                              <WeightBox kg={weightKg} maxKg={maxWeightKg} />
                              {/* Flex sizing lives on the wrappers, never on the
                                  controls themselves — inputClass already sets
                                  w-full, and the two would otherwise fight. */}
                              <div className="flex-1 min-w-0 space-y-2">
                                <div className="flex items-stretch gap-2">
                                  <div className="flex-1 min-w-0">
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      placeholder={
                                        weightUnit === "gm" ? "500" : "1"
                                      }
                                      value={weightInput}
                                      onChange={(e) => {
                                        let next = e.target.value;
                                        if (weightUnit === "gm") {
                                          next = next
                                            .replace(/\D/g, "")
                                            .slice(0, String(Math.round(maxWeightKg * 1000)).length);
                                        } else {
                                          next = next.replace(/[^\d.]/g, "");
                                          const parts = next.split(".");
                                          if (parts.length > 2) {
                                            next = `${parts[0]}.${parts.slice(1).join("")}`;
                                          }
                                          if (parts[1]?.length > 3) {
                                            next = `${parts[0]}.${parts[1].slice(0, 3)}`;
                                          }
                                        }
                                        setWeightInput(next);
                                      }}
                                      className={cn(
                                        inputClass(weightKg > 0),
                                        "text-[20px] font-bold tabular-nums",
                                      )}
                                      style={{ fontFamily: MONO }}
                                    />
                                  </div>
                                  <div className="w-[86px] shrink-0">
                                    <select
                                      value={weightUnit}
                                      onChange={(e) => {
                                        const nextUnit = e.target.value;
                                        const n = parseFloat(weightInput);
                                        if (Number.isFinite(n) && n > 0) {
                                          if (
                                            nextUnit === "gm" &&
                                            weightUnit === "kg"
                                          ) {
                                            setWeightInput(
                                              String(Math.round(n * 1000)),
                                            );
                                          } else if (
                                            nextUnit === "kg" &&
                                            weightUnit === "gm"
                                          ) {
                                            const kg = n / 1000;
                                            setWeightInput(
                                              Number.isInteger(kg)
                                                ? String(kg)
                                                : String(
                                                    Math.round(kg * 1000) /
                                                      1000,
                                                  ),
                                            );
                                          }
                                        }
                                        setWeightUnit(nextUnit);
                                      }}
                                      className={cn(
                                        inputClass(true),
                                        "font-bold text-sm",
                                      )}>
                                      <option value="kg">KG</option>
                                      <option value="gm">GM</option>
                                    </select>
                                  </div>
                                </div>
                                <p
                                  className={`text-[11px] font-medium ${
                                    weightKg > maxWeightKg
                                      ? "text-amber-700"
                                      : "text-slate-400"
                                  }`}
                                  style={{ fontFamily: MONO }}>
                                  {weightKg > maxWeightKg
                                    ? `Over the ${maxWeightKg} kg limit`
                                    : weightUnit === "gm" && weightKg > 0
                                      ? `= ${weightKg} KG`
                                      : `Limit ${maxWeightKg} KG`}
                                </p>
                              </div>
                            </div>
                          </Field>
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <Field
                            label="How soon should a rider arrive?"
                            hint="This is the pickup wait, not the courier's transit time.">
                            <Segmented
                              name="speed"
                              options={DELIVERY_SPEED_OPTIONS.map((option) => {
                                const configuredExpress = Math.max(
                                  Number(expressCharge) || 0,
                                  Number(
                                    fareEstimation?.configuredExpressCharge,
                                  ) || 0,
                                );
                                const estimatedExpress =
                                  Number(fareEstimation?.expressCharge) || 0;
                                const extraFee =
                                  option.value === "express"
                                    ? Math.max(
                                        configuredExpress,
                                        estimatedExpress,
                                      )
                                    : 0;
                                return {
                                  value: option.value,
                                  label: option.label,
                                  helper:
                                    option.value === "express" && extraFee > 0
                                      ? `${option.timeLabel} · +${formatInr(extraFee)}`
                                      : option.timeLabel,
                                };
                              })}
                              value={deliverySpeed}
                              onChange={(nextSpeed) => {
                                if (deliverySpeed === nextSpeed) return;
                                setDeliverySpeed(nextSpeed);
                                // Instant UI update while the API recalculates
                                setFareEstimation((prev) => {
                                  if (!prev) return prev;
                                  const days = Math.max(
                                    1,
                                    Number(prev.billableDays) || 1,
                                  );
                                  const prevExpress =
                                    Number(prev.expressCharge) || 0;
                                  const rate = Math.max(
                                    Number(expressCharge) || 0,
                                    Number(prev.configuredExpressCharge) || 0,
                                  );
                                  const nextExpress =
                                    nextSpeed === "express" ? rate : 0;
                                  const delta =
                                    (nextExpress - prevExpress) * days;
                                  return {
                                    ...prev,
                                    expressCharge: nextExpress,
                                    dailyFare: Number(
                                      (
                                        (Number(prev.dailyFare ?? prev.fare) ||
                                          0) -
                                        prevExpress +
                                        nextExpress
                                      ).toFixed(2),
                                    ),
                                    fare: Number(
                                      (
                                        (Number(prev.fare) || 0) + delta
                                      ).toFixed(2),
                                    ),
                                  };
                                });
                              }}
                            />
                          </Field>
                        </Sheet>
                      </motion.div>

                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          {availableSegments.length > 0 && (
                            <Field label="Sending as">
                              <Segmented
                                name="segment"
                                options={availableSegments}
                                value={packageSegment}
                                onChange={setPackageSegment}
                              />
                            </Field>
                          )}

                          {packageSegment && segmentCategories.length > 0 && (
                            <Field
                              label="Category"
                              filled={Boolean(packageCategory)}>
                              <select
                                value={packageCategory}
                                onChange={(e) =>
                                  setPackageCategory(e.target.value)
                                }
                                className={inputClass(
                                  Boolean(packageCategory),
                                )}>
                                {segmentCategories.map((cat) => (
                                  <option key={cat.value} value={cat.value}>
                                    {cat.label}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          )}

                          <Field
                            label="What's inside"
                            hint="Helps the rider handle it correctly."
                            filled={Boolean(description.trim())}>
                            <textarea
                              rows={2}
                              placeholder={packageDescriptionPlaceholder}
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              className={cn(
                                inputClass(Boolean(description.trim())),
                                "resize-none",
                              )}
                            />
                          </Field>
                        </Sheet>
                      </motion.div>
                    </div>
                  )}

                  {/* ── PAY ──────────────────────────────────────────── */}
                  {step === 3 && (
                    <div className="space-y-3">
                      <motion.div variants={stackItem}>
                        <Sheet className="p-5 space-y-4">
                          <Field label="How do you want to pay?">
                            <Segmented
                              name="payment"
                              options={[
                                {
                                  value: "COD",
                                  label: "Cash",
                                  helper: "On pickup",
                                },
                                {
                                  value: "UPI",
                                  label: "UPI",
                                  helper: "Pay now",
                                },
                                {
                                  value: "WALLET",
                                  label: "Wallet",
                                  helper:
                                    walletBalance == null
                                      ? "Pay now"
                                      : `₹${walletBalance.toLocaleString("en-IN")}`,
                                },
                              ]}
                              columns={3}
                              value={paymentMethod}
                              onChange={setPaymentMethod}
                            />
                          </Field>
                          {paymentMethod === "WALLET" && walletShort && (
                            <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 text-sm text-amber-800">
                              <p className="font-semibold">
                                Wallet balance is ₹{(walletBalance || 0).toLocaleString("en-IN")} — ₹
                                {(totalFare - (walletBalance || 0)).toFixed(2)} short.
                              </p>
                              <button
                                type="button"
                                onClick={() => navigate("/wallet")}
                                className="mt-1.5 font-bold text-[color:var(--primary)] underline underline-offset-2">
                                Add money to wallet
                              </button>
                            </div>
                          )}
                          {paymentMethod === "WALLET" && !walletShort && (
                            <p className="text-xs text-slate-500">
                              Paid from your wallet right away. If you cancel, the money returns to your wallet.
                            </p>
                          )}
                        </Sheet>
                      </motion.div>

                      {fareError && (
                        <motion.div variants={stackItem}>
                          <div className="rounded-2xl bg-red-50 border border-red-100 text-red-700 text-sm font-semibold px-4 py-3">
                            {fareError}
                          </div>
                        </motion.div>
                      )}

                      {/* The consignment receipt */}
                      <motion.div variants={stackItem}>
                        <div className="rounded-[26px] bg-[#0B1220] text-white overflow-hidden shadow-[0_20px_50px_-24px_rgba(11,18,32,0.9)]">
                          <div className="px-5 pt-5 pb-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <Caption className="text-slate-400">
                                  Total to pay
                                </Caption>
                                <div className="text-[34px] leading-none font-black tracking-[-0.03em] mt-2 tabular-nums">
                                  <Money value={totalFare} />
                                </div>
                              </div>
                              {fareEstimation && fareEstimation.distance != null && (
                                <div className="text-right">
                                  <Caption className="text-slate-400">
                                    Distance
                                  </Caption>
                                  <div
                                    className="text-[15px] font-bold mt-1.5 tabular-nums"
                                    style={{ fontFamily: MONO }}>
                                    {fareEstimation.distance} km
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          {fareEstimation && (
                            <>
                              <div className="px-5">
                                <div
                                  className="h-px"
                                  style={{
                                    backgroundImage:
                                      "repeating-linear-gradient(to right, rgba(255,255,255,0.25) 0 4px, transparent 4px 9px)",
                                  }}
                                />
                              </div>
                              <div className="px-5 py-4 space-y-2.5">
                                {Number(fareEstimation.fixedDeliveryCharge) > 0 ? (
                                  <LeaderRow
                                    label="Delivery charge"
                                    value={`₹${Number(fareEstimation.fixedDeliveryCharge).toFixed(2)}`}
                                  />
                                ) : null}
                                {Number(fareEstimation.weightFare) > 0 && (
                                  <LeaderRow
                                    label={`Weight ${weightKg} kg`}
                                    value={`₹${Number(fareEstimation.weightFare).toFixed(2)}`}
                                  />
                                )}
                                {Number(fareEstimation.courierCharge) > 0 && (
                                  <LeaderRow
                                    label={`${courierCompany || "Courier"} charge (${pickupDetails.city} → ${destinationCity})`}
                                    value={`₹${Number(fareEstimation.courierCharge).toFixed(2)}`}
                                  />
                                )}
                                {deliverySpeed === "express" && (
                                  <LeaderRow
                                    label="Express pickup"
                                    value={`₹${Number(fareEstimation.expressCharge || 0).toFixed(2)}`}
                                  />
                                )}
                                {/* GST on its own line, before the customer commits.
                                    Hidden on a tax-inclusive rate card, where the total
                                    already contains it and an extra line would read as a
                                    surcharge. Taxed on the multi-day total, so it sits
                                    alongside the day multiplier rather than inside it. */}
                                {Number(fareEstimation.gstAmount) > 0 &&
                                  !fareEstimation.gstInclusive && (
                                    <LeaderRow
                                      label={`GST (${Number(fareEstimation.gstPercent) || 0}%)`}
                                      value={`₹${Number(fareEstimation.gstAmount).toFixed(2)}`}
                                    />
                                  )}
                                {Number(fareEstimation.billableDays) > 1 && (
                                  <>
                                    <LeaderRow
                                      label="Daily rate"
                                      value={`₹${Number(
                                        fareEstimation.dailyFare ??
                                          fareEstimation.fare,
                                      ).toFixed(2)}`}
                                    />
                                    <LeaderRow
                                      label={`× ${Number(fareEstimation.billableDays)} days`}
                                      value={`₹${Number(fareEstimation.fare).toFixed(2)}`}
                                      strong
                                    />
                                  </>
                                )}
                                {appliedCoupon && (
                                  <LeaderRow
                                    label={`Coupon (${appliedCoupon.code})`}
                                    value={`-₹${Number(appliedCoupon.discountAmount).toFixed(2)}`}
                                  />
                                )}
                              </div>
                            </>
                          )}

                          <div className="px-5 pb-5 flex items-center justify-between gap-4">
                            <HandoffDiagramDark
                              counter={courierCompany}
                              destination={destinationCity}
                            />
                            {fareEstimation && !estimating && (
                              <Stamp tone="#4ADE80">Priced</Stamp>
                            )}
                          </div>
                        </div>
                      </motion.div>

                      {fareEstimation && (
                        <motion.div variants={stackItem}>
                          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-[12px] font-bold uppercase tracking-wide text-slate-500">
                                Coupon
                              </span>
                              {appliedCoupon && (
                                <button
                                  type="button"
                                  onClick={removeCoupon}
                                  className="text-[12px] font-semibold text-red-600"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                            {appliedCoupon ? (
                              <p className="text-[13px] text-emerald-700">
                                <strong>{appliedCoupon.code}</strong> applied — you saved ₹
                                {Number(appliedCoupon.discountAmount).toFixed(2)}
                              </p>
                            ) : (
                              <>
                                <div className="flex gap-2">
                                  <input
                                    value={couponCode}
                                    onChange={(e) =>
                                      setCouponCode(e.target.value.toUpperCase())
                                    }
                                    placeholder="Enter coupon code"
                                    className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-slate-400"
                                  />
                                  <button
                                    type="button"
                                    disabled={!couponCode || applyingCoupon}
                                    onClick={() => applyCoupon(couponCode)}
                                    className="rounded-xl bg-slate-900 px-4 text-[13px] font-semibold text-white disabled:opacity-50"
                                  >
                                    {applyingCoupon ? "…" : "Apply"}
                                  </button>
                                </div>
                                {couponError && (
                                  <p className="text-[12px] text-red-600">{couponError}</p>
                                )}
                                {availableCoupons.length > 0 && (
                                  <div className="flex gap-2 overflow-x-auto pb-1">
                                    {availableCoupons.map((c) => (
                                      <button
                                        key={c.code}
                                        type="button"
                                        onClick={() => applyCoupon(c.code)}
                                        className="flex-shrink-0 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                                      >
                                        {c.code} ·{" "}
                                        {c.discountType === "percentage"
                                          ? `${c.discountValue}% OFF`
                                          : `₹${c.discountValue} OFF`}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </motion.div>
                      )}

                      {!pickupDetails.lat && (
                        <motion.div variants={stackItem}>
                          <div className="flex items-start gap-2.5 text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-[12px] font-semibold">
                            <AlertTriangle
                              size={15}
                              className="shrink-0 mt-px"
                            />
                            <span>
                              Set the pickup point on the map to see the
                              distance and fare.{" "}
                              <button
                                type="button"
                                onClick={() => goToStep(0)}
                                className="underline underline-offset-2">
                                Go back to From
                              </button>
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </div>
                  )}
                </motion.div>
              </StepPane>
            </AnimatePresence>
          </div>

          {/* ── Actions, in flow at the end of the step ─────────────────── */}
          <div className="mt-5 flex items-center gap-2.5">
            {step > 0 && (
              <motion.button
                type="button"
                onClick={() => goToStep(step - 1)}
                whileTap={reduce ? undefined : { scale: 0.94 }}
                className="grid place-items-center h-[54px] w-[54px] shrink-0 rounded-2xl bg-white border border-slate-200 text-slate-700 shadow-[0_10px_30px_-12px_rgba(15,23,42,0.4)]"
                aria-label="Back a step">
                <ArrowLeft size={19} />
              </motion.button>
            )}

            {!isLastStep ? (
              <motion.button
                type="button"
                onClick={handleContinue}
                whileTap={reduce ? undefined : { scale: 0.98 }}
                className="flex-1 h-[54px] rounded-2xl bg-[color:var(--primary)] text-white font-bold text-[15px] flex items-center justify-center gap-2 shadow-[0_14px_34px_-12px_color-mix(in_srgb,var(--primary)_75%,transparent)]">
                Continue
                <ArrowRight size={18} />
              </motion.button>
            ) : (
              <motion.button
                type="submit"
                disabled={submitBlocked || walletShort}
                whileTap={reduce || submitBlocked || walletShort ? undefined : { scale: 0.98 }}
                className="flex-1 h-[54px] rounded-2xl bg-[color:var(--primary)] text-white font-bold text-[15px] flex items-center justify-center gap-2 shadow-[0_14px_34px_-12px_color-mix(in_srgb,var(--primary)_75%,transparent)] disabled:opacity-45 disabled:shadow-none">
                {loading ? (
                  <>
                    <Truck size={18} className="animate-pulse" />
                    Booking…
                  </>
                ) : !paymentMethod ? (
                  "Select a payment method"
                ) : paymentMethod === "UPI" ? (
                  <>
                    Pay <Money value={totalFare} /> and request
                  </>
                ) : paymentMethod === "WALLET" ? (
                  <>
                    Pay <Money value={totalFare} /> from wallet
                  </>
                ) : (
                  <>
                    Request pickup
                    <ArrowRight size={18} />
                  </>
                )}
              </motion.button>
            )}
          </div>
        </form>
      </div>

      {/* Map Picker Modal */}
      {mapPickerTarget && (
        <MapPicker
          isOpen={true}
          onClose={() => setMapPickerTarget(null)}
          onConfirm={handleMapConfirm}
          initialLocation={pickupDetails}
          preferCurrentLocationOnOpen={true}
          title="Select Pickup Location"
          searchPlaceholder="Search for pickup area..."
          showRadius={false}
          boundaries={zones}
          boundaryLabel="a serviceable zone"
        />
      )}

      {/* Explicit confirm — the submit button alone used to be indistinguishable
          from every "Continue" button before it, and COD has no Razorpay screen
          to act as a natural point of no return, so a tap here placed a real,
          unconfirmed order. */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm this booking?"
        size="sm"
        footer={
          <div className="flex gap-2 w-full">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="flex-1 h-11 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmAndBook}
              disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[color:var(--primary)] text-white font-bold text-sm disabled:opacity-60">
              {loading ? "Booking…" : "Yes, book it"}
            </button>
          </div>
        }>
        <div className="space-y-2 text-sm">
          <p className="text-slate-600">
            A rider will be requested to pick up from{" "}
            <span className="font-bold text-slate-900">
              {pickupDetails.city || "your address"}
            </span>{" "}
            and route this to <span className="font-bold text-slate-900">{destinationCity}</span> via{" "}
            <span className="font-bold text-slate-900">{courierCompany}</span>.
          </p>
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 flex items-center justify-between">
            <span className="text-slate-500 font-semibold">
              {paymentMethod === "UPI"
                ? "Pay now (UPI)"
                : paymentMethod === "WALLET"
                  ? "Pay from wallet"
                  : "Cash on pickup"}
            </span>
            <span className="font-black text-slate-900 text-base">
              ₹{totalFare.toFixed(2)}
            </span>
          </div>
        </div>
      </Modal>
    </div>
  );
};

/** Same diagram, tuned for the dark receipt. */
const HandoffDiagramDark = ({ counter, destination }) => (
  <div className="flex items-center gap-2 min-w-0">
    {[
      { icon: MapPin, label: "You" },
      { icon: Store, label: counter || "Counter" },
      { icon: Navigation, label: destination || "City" },
    ].map((node, i, all) => (
      <React.Fragment key={node.label + i}>
        <div className="flex items-center gap-1.5 min-w-0">
          <node.icon size={12} className="text-slate-400 shrink-0" />
          <span
            className="text-[10px] uppercase tracking-[0.12em] text-slate-400 truncate"
            style={{ fontFamily: MONO }}>
            {node.label}
          </span>
        </div>
        {i < all.length - 1 && (
          <span className="text-slate-600 text-[10px] shrink-0">→</span>
        )}
      </React.Fragment>
    ))}
  </div>
);

export default ParcelDeliveryPage;
