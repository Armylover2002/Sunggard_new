import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Phone,
  ArrowRight,
  CheckCircle,
  ShieldCheck,
  ChevronLeft,
  User,
  Bike,
  ChevronDown,
  Mail,
  MapPin,
  FileText,
  Upload,
  X,
  Camera,
  XCircle,
  // CAR WASH DISABLED — Sparkles,
  Truck,
  Package,
  Store,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Lottie from "lottie-react";
import deliveryRiding from "@/assets/Delivery Riding.json";
import { deliveryApi } from "../services/deliveryApi";
import { zonesApi } from "@shared/services/zonesApi";
import { formatZoneLabel } from "@shared/utils/zoneGeometry";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import LegalSheet from "@shared/components/auth/LegalSheet";
import { toast } from "sonner";
import { compressImage } from "@shared/utils/compressImage";

const VEHICLE_TYPES = [
  { value: "bike", label: "Bike" },
  { value: "scooter", label: "Scooter" },
  { value: "cycle", label: "Cycle" },
];

/**
 * Quick Orders and Both are hidden for now — onboarding is parcel-only
 * until quick commerce fleet signup reopens. Kept in the value set (not
 * deleted) so re-enabling later is a one-line revert.
 */
const SERVICE_TYPES = [
  { value: "parcel", label: "Courier", description: "Courier pick-ups & drops", icon: Package },
  // { value: "quick-orders", label: "Quick Orders", description: "Store & marketplace orders", icon: Store },
  // { value: "both", label: "Both", description: "Parcel and quick orders", icon: Truck },
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VEHICLE_PLATE_REGEX = /^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAR_REGEX = /^[0-9]{12}$/;
const DL_REGEX = /^(DL[0-9]{13}|[A-Z]{2}[0-9]{2}[0-9]{4}[0-9]{7})$/;

const sanitizeFullName = (value) =>
  value.replace(/[^A-Za-z\s.'-]/g, "").replace(/\s+/g, " ");

const formatVehiclePlate = (value) => {
  const raw = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  let plate = "";

  for (let i = 0; i < raw.length && plate.length < 10; i += 1) {
    const char = raw[i];
    const pos = plate.length;

    if (pos < 2 || (pos >= 4 && pos < 6)) {
      if (/[A-Z]/.test(char)) plate += char;
    } else if ((pos >= 2 && pos < 4) || pos >= 6) {
      if (/[0-9]/.test(char)) plate += char;
    }
  }

  if (plate.length <= 2) return plate;
  if (plate.length <= 4) return `${plate.slice(0, 2)} ${plate.slice(2)}`;
  if (plate.length <= 6) return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4)}`;
  return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4, 6)} ${plate.slice(6)}`;
};

const normalizeVehiclePlate = (value) => value.replace(/\s/g, "").toUpperCase();

const formatDrivingLicense = (value) => {
  const upper = value.toUpperCase();
  if (upper.startsWith("DL")) {
    const digits = upper.slice(2).replace(/[^0-9]/g, "").slice(0, 13);
    return digits ? `DL-${digits}` : "DL-";
  }

  const raw = upper.replace(/[^A-Z0-9]/g, "");
  let dl = "";

  for (let i = 0; i < raw.length && dl.length < 15; i += 1) {
    const char = raw[i];
    const pos = dl.length;

    if (pos < 2) {
      if (/[A-Z]/.test(char)) dl += char;
    } else {
      if (/[0-9]/.test(char)) dl += char;
    }
  }

  return dl;
};

const normalizeDrivingLicense = (value) => value.replace(/[\s-]/g, "").toUpperCase();

const formatPanNumber = (value) => {
  const raw = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  let pan = "";

  for (let i = 0; i < raw.length && pan.length < 10; i += 1) {
    const char = raw[i];
    const pos = pan.length;

    if (pos < 5) {
      if (/[A-Z]/.test(char)) pan += char;
    } else if (pos < 9) {
      if (/[0-9]/.test(char)) pan += char;
    } else if (/[A-Z]/.test(char)) {
      pan += char;
    }
  }

  return pan;
};

const extractAadharDigits = (text) => {
  const matches = String(text || "").replace(/\D/g, "").match(/\d{12}/g);
  return matches?.[0] || "";
};

const extractPanFromText = (text) => {
  const match = String(text || "").toUpperCase().match(/[A-Z]{5}\d{4}[A-Z]/);
  return match ? match[0] : "";
};

const isValidFullName = (value) => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && /^[A-Za-z]+(?:[ '.-][A-Za-z]+)*$/.test(trimmed);
};

const validateSignupStep1 = ({
  signupName,
  signupPhone,
  signupEmail,
  signupAddress,
  profileImageFile,
  signupServiceType,
  zones,
  signupZoneId,
}) => {
  if (!signupName.trim() || !signupPhone || !signupEmail || !signupAddress || !profileImageFile) {
    return "Please fill all personal information fields and upload photo";
  }
  if (!isValidFullName(signupName)) {
    return "Full name should contain only letters (no numbers)";
  }
  if (signupPhone.length !== 10) {
    return "Please enter a valid 10-digit phone number";
  }
  if (!EMAIL_REGEX.test(signupEmail)) {
    return "Please enter a valid email address";
  }
  if (!signupServiceType) {
    return "Please select which services you will serve";
  }
  if ((zones || []).length > 0 && !signupZoneId) {
    return "Please select the zone you will deliver in";
  }
  return null;
};

const validateSignupStep2 = ({ signupVehicleNumber, signupDLNumber }) => {
  if (!signupVehicleNumber.trim()) {
    return "Please enter your vehicle plate number";
  }
  if (!VEHICLE_PLATE_REGEX.test(normalizeVehiclePlate(signupVehicleNumber))) {
    return "Vehicle plate must be 2 letters, 2 digits, 2 letters, then 4 digits (e.g. KA 05 MN 8921)";
  }
  if (!signupDLNumber.trim()) {
    return "Please enter your driving license number";
  }
  if (!DL_REGEX.test(normalizeDrivingLicense(signupDLNumber))) {
    return "Driving license must be DL- followed by 13 digits, or 15-character state format";
  }
  return null;
};

const validateSignupStep3 = ({ signupAadharNumber, signupPanNumber, signupAccountHolder, signupAccountNumber, signupIfsc }) => {
  if (!signupAadharNumber || !signupPanNumber || !signupAccountHolder || !signupAccountNumber || !signupIfsc) {
    return "Please fill all bank and identification fields";
  }
  if (!AADHAR_REGEX.test(signupAadharNumber)) {
    return "Aadhar number must be exactly 12 digits";
  }
  if (!PAN_REGEX.test(signupPanNumber)) {
    return "PAN must be 5 letters, 4 digits, then 1 letter (e.g. ABCDE1234F)";
  }
  return null;
};

const DeliveryAuth = () => {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const appName = settings?.appName || "App";
  const logoUrl = settings?.logoUrl || "";
  const { login } = useAuth();

  // mode: "login" | "signup"
  const [mode, setMode] = useState("login");
  const [step, setStep] = useState("form"); // "form" | "otp"

  // Login state
  const [loginPhone, setLoginPhone] = useState("");

  // Signup state
  const [signupStep, setSignupStep] = useState(1);
  const [signupName, setSignupName] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupAddress, setSignupAddress] = useState("");
  const [signupVehicle, setSignupVehicle] = useState("bike");
  const [signupVehicleNumber, setSignupVehicleNumber] = useState("");
  const [signupDLNumber, setSignupDLNumber] = useState("");
  const [signupPanNumber, setSignupPanNumber] = useState("");
  const [signupAadharNumber, setSignupAadharNumber] = useState("");
  const [signupAccountNumber, setSignupAccountNumber] = useState("");
  const [signupIfsc, setSignupIfsc] = useState("");
  const [signupAccountHolder, setSignupAccountHolder] = useState("");
  const [signupServiceType, setSignupServiceType] = useState("");
  const [signupZoneId, setSignupZoneId] = useState("");
  const [zones, setZones] = useState([]);
  const [showVehicleDropdown, setShowVehicleDropdown] = useState(false);
  const [profileImageFile, setProfileImageFile] = useState(null);
  const [profileImagePreview, setProfileImagePreview] = useState("");

  // Document states
  const [aadharFrontFile, setAadharFrontFile] = useState(null);
  const [aadharBackFile, setAadharBackFile] = useState(null);
  const [panFile, setPanFile] = useState(null);
  const [dlFile, setDlFile] = useState(null);

  // OTP state
  const [otp, setOtp] = useState(["", "", "", ""]);
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [timer, setTimer] = useState(30);
  const [legalKind, setLegalKind] = useState(null);
  const [checkingPhone, setCheckingPhone] = useState(false);


  useEffect(() => {
    let interval;
    if (step === "otp" && timer > 0) {
      interval = setInterval(() => setTimer((prev) => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [step, timer]);

  // Fetched once, up front, so picking a zone (and validating it) never costs
  // a network round trip beyond this single load.
  useEffect(() => {
    let cancelled = false;
    zonesApi
      .getActiveZones()
      .then((res) => {
        if (!cancelled) setZones(res.data?.results || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Documents are accepted as uploaded and checked by a human at approval.
   *
   * These previously ran the image through in-browser OCR and refused the
   * file when the text did not match what the rider had typed. It rejected
   * too many genuine documents — a slight angle, a worn card, or a plain
   * shadow was enough — and left applicants with no way past the step.
   * Admin review already covers this properly.
   */
  const handleDLUpload = async (file) =>
    setDlFile(file ? await compressImage(file) : null);
  const handlePanUpload = async (file) =>
    setPanFile(file ? await compressImage(file) : null);
  const handleAadharFrontUpload = async (file) =>
    setAadharFrontFile(file ? await compressImage(file) : null);
  const handleAadharBackUpload = async (file) =>
    setAadharBackFile(file ? await compressImage(file) : null);

  const handleSendOtp = async () => {
    try {
      setLoading(true);
      if (mode === "login") {
        if (!loginPhone || loginPhone.length < 10) {
          toast.error("Please enter a valid 10-digit phone number");
          return;
        }
        const res = await deliveryApi.sendLoginOtp({ phone: loginPhone });
        toast.success(res.data?.message || "OTP sent!");
      } else {
        const step1Error = validateSignupStep1({
          signupName,
          signupPhone,
          signupEmail,
          signupAddress,
          profileImageFile,
          signupServiceType,
          zones,
          signupZoneId,
        });
        if (step1Error) { toast.error(step1Error); return; }

        const step2Error = validateSignupStep2({ signupVehicleNumber, signupDLNumber });
        if (step2Error) { toast.error(step2Error); return; }

        const step3Error = validateSignupStep3({
          signupAadharNumber,
          signupPanNumber,
          signupAccountHolder,
          signupAccountNumber,
          signupIfsc,
        });
        if (step3Error) { toast.error(step3Error); return; }

        const formData = new FormData();
        formData.append("name", signupName.trim());
        formData.append("phone", signupPhone);
        formData.append("vehicleType", signupVehicle);
        formData.append("email", signupEmail.trim().toLowerCase());
        formData.append("address", signupAddress);
        formData.append("vehicleNumber", normalizeVehiclePlate(signupVehicleNumber));
        formData.append("drivingLicenseNumber", normalizeDrivingLicense(signupDLNumber));
        formData.append("accountHolder", signupAccountHolder);
        formData.append("accountNumber", signupAccountNumber);
        formData.append("ifsc", signupIfsc);
        formData.append("aadharNumber", signupAadharNumber);
        formData.append("aadhar_number", signupAadharNumber);
        formData.append("panNumber", signupPanNumber);
        formData.append("pan_number", signupPanNumber);
        formData.append("serviceType", signupServiceType);
        if (signupZoneId) formData.append("zoneId", signupZoneId);

        if (profileImageFile) formData.append("profileImage", profileImageFile);
        if (aadharFrontFile) formData.append("aadharFront", aadharFrontFile);
        if (aadharBackFile) formData.append("aadharBack", aadharBackFile);
        if (panFile) formData.append("pan", panFile);
        if (dlFile) formData.append("dl", dlFile);

        const res = await deliveryApi.sendSignupOtp(formData);
        toast.success(res.data?.message || "OTP sent!");
      }
      setOtp(["", "", "", ""]);
      setTimer(30);
      setStep("otp");
    } catch (error) {
      console.error(error);

      /**
       * "Failed to send OTP" was shown for everything, including the case
       * where no response arrived at all — so a timeout on a slow upload, a
       * dropped connection, and a real server rejection were indistinguishable
       * to the person waiting, and to anyone trying to debug it.
       */
      const server = error.response?.data?.message;
      if (server) {
        toast.error(server);
      } else if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
        toast.error("That took too long — check your connection and try again.");
      } else if (!error.response) {
        toast.error("Couldn't reach the server. Check your connection and try again.");
      } else {
        toast.error(`Something went wrong (${error.response.status}). Please try again.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.some((d) => d === "") || !agreed) return;
    setLoading(true);
    try {
      const phone = mode === "login" ? loginPhone : signupPhone;
      const otpString = otp.join("");
      const response = await deliveryApi.verifyOtp({ phone, otp: otpString });
      const { token, delivery } = response.data.result;

      login({ ...delivery, token, role: "delivery" });

      if (delivery?.isVerified) {
        toast.success("Welcome! Redirecting to dashboard...");
        navigate("/delivery/dashboard");
      } else {
        toast.success("Registration complete! Your application is pending admin approval.");
        navigate("/delivery/pending-approval");
      }
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.message || "Invalid OTP");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index, value) => {
    if (isNaN(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);
    if (value && index < 3) {
      document.getElementById(`otp-${index + 1}`)?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      document.getElementById(`otp-${index - 1}`)?.focus();
    }
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setStep("form");
    setOtp(["", "", "", ""]);
    setLoginPhone("");
    setSignupStep(1);
    setSignupName("");
    setSignupPhone("");
    setSignupEmail("");
    setSignupAddress("");
    setSignupVehicle("bike");
    setSignupVehicleNumber("");
    setSignupDLNumber("");
    setSignupServiceType("");
    setSignupZoneId("");
    setSignupAadharNumber("");
    setSignupPanNumber("");
    setSignupAccountNumber("");
    setSignupIfsc("");
    setSignupAccountHolder("");
    setAadharFrontFile(null);
    setAadharBackFile(null);
    setPanFile(null);
    setDlFile(null);
    setAgreed(false);
    setProfileImageFile(null);
    setProfileImagePreview("");
  };

  const slideVariants = {
    hidden: { opacity: 0, x: 30 },
    visible: { opacity: 1, x: 0, transition: { duration: 0.3 } },
    exit: { opacity: 0, x: -30, transition: { duration: 0.2 } },
  };

  return (
    <div className="min-h-screen bg-[#F0F4FF] flex flex-col items-center justify-center p-5 font-['Outfit',_sans-serif]">
      {/* Background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 -left-32 w-80 h-80 bg-brand-200/40 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-purple-200/30 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-[420px] relative z-10"
      >
        {/* Card */}
        <div className="bg-white rounded-[2.5rem] shadow-[0_24px_60px_rgba(99,102,241,0.1)] border border-brand-50 overflow-hidden">

          {/* Header with Lottie */}
          <div className="bg-gradient-to-br from-brand-50 to-purple-50 p-8 flex flex-col items-center relative">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
              <div className="w-14 h-14 rounded-2xl bg-white/85 backdrop-blur-sm border border-brand-100 shadow-sm overflow-hidden">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={`${appName} logo`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-brand-600" />
                  </div>
                )}
              </div>
            </div>
            <div className="w-40 h-40">
              <Lottie animationData={deliveryRiding} loop />
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={`${mode}-${step}-title`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="text-center mt-3"
              >
                <h1 className="text-2xl font-black text-gray-900">
                  {step === "otp"
                    ? "Verify OTP"
                    : mode === "login"
                      ? "Partner Login"
                      : "Partner Registration"}
                </h1>
                <p className="text-gray-500 text-sm mt-1 max-w-[240px] mx-auto">
                  {step === "otp"
                    ? `Enter the 4-digit code sent to +91 ${mode === "login" ? loginPhone : signupPhone}`
                    : mode === "login"
                      ? "Login with your registered phone number"
                      : `Step ${signupStep} of 4: ${signupStep === 1 ? "Personal Info" : signupStep === 2 ? "Vehicle Info" : signupStep === 3 ? "Bank Info" : "Documents"}`}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Tab Switch */}
          {step === "form" && (
            <div className="flex mx-6 mt-6 bg-gray-100 rounded-2xl p-1">
              {["login", "signup"].map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`flex-1 py-2.5 text-sm font-black rounded-xl transition-all duration-300 ${mode === m
                    ? "bg-white text-brand-600 shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                    }`}
                >
                  {m === "login" ? "Login" : "Join Now"}
                </button>
              ))}
            </div>
          )}

          {/* Form Body */}
          <div className="p-6 pt-4">
            <AnimatePresence mode="wait">
              {step === "form" && (
                <motion.div
                  key={`form-${mode}`}
                  variants={slideVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="space-y-4"
                >
                  {/* ────────── SIGNUP MODE ────────── */}
                  {mode === "signup" && (
                    <div className="space-y-4">
                      {/* Step 1: Personal Information */}
                      {signupStep === 1 && (
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-4"
                        >
                          {/* Profile Photo Capture */}
                          <div className="flex flex-col items-center justify-center py-2">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3 self-start ml-1">Profile Photo</label>
                            <div className="relative group">
                              <div className="w-24 h-24 rounded-3xl bg-brand-50 border-2 border-dashed border-brand-200 flex items-center justify-center overflow-hidden transition-all group-hover:border-brand-400">
                                {profileImagePreview ? (
                                  <img src={profileImagePreview} alt="Preview" className="w-full h-full object-cover" />
                                ) : (
                                  <User className="w-10 h-10 text-brand-300" />
                                )}
                              </div>
                              <input
                                type="file"
                                accept="image/*"
                                capture="user"
                                id="profile-upload"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files[0];
                                  if (file) {
                                    setProfileImageFile(file);
                                    setProfileImagePreview(URL.createObjectURL(file));
                                  }
                                }}
                              />
                              <label
                                htmlFor="profile-upload"
                                className="absolute -bottom-2 -right-2 p-2.5 bg-black  text-primary-foreground rounded-2xl shadow-lg shadow-brand-200 cursor-pointer hover:bg-brand-700 hover:scale-110 active:scale-95 transition-all"
                              >
                                <Camera className="w-4 h-4" />
                              </label>
                            </div>
                            <p className="text-[10px] text-gray-400 font-bold mt-3">Upload a clear photo of your face</p>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Full Name</label>
                            <div className="relative">
                              <User className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <input
                                type="text"
                                value={signupName}
                                onChange={(e) => setSignupName(sanitizeFullName(e.target.value))}
                                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all"
                                placeholder="Enter your full name"
                              />
                            </div>
                            <p className="text-[10px] text-gray-400 font-bold ml-1">Letters and spaces only</p>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Phone Number</label>
                            <div className="relative">
                              <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <span className="absolute left-10 top-1/2 -translate-y-1/2 text-gray-500 font-bold text-sm border-r border-gray-200 pr-2.5">+91</span>
                              <input
                                type="tel"
                                value={signupPhone}
                                onChange={(e) => setSignupPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                                maxLength={10}
                                className="w-full pl-24 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all"
                                placeholder="00000 00000"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Email Address</label>
                            <div className="relative">
                              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <input
                                type="email"
                                value={signupEmail}
                                onChange={(e) => setSignupEmail(e.target.value.toLowerCase())}
                                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all lowercase"
                                placeholder="example@gmail.com"
                                autoCapitalize="none"
                                autoCorrect="off"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Permanent Address</label>
                            <div className="relative">
                              <MapPin className="absolute left-4 top-4 text-gray-300 w-4 h-4" />
                              <textarea
                                value={signupAddress}
                                onChange={(e) => setSignupAddress(e.target.value)}
                                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all resize-none h-24"
                                placeholder="Complete building address..."
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Services You Will Serve</label>
                            <div className="grid grid-cols-1 gap-2 mt-1">
                              {SERVICE_TYPES.map((service) => {
                                const Icon = service.icon;
                                const isSelected = signupServiceType === service.value;
                                return (
                                  <button
                                    key={service.value}
                                    type="button"
                                    onClick={() => setSignupServiceType(service.value)}
                                    className={`py-3.5 px-4 rounded-2xl text-left transition-all border-2 flex items-center gap-3 ${
                                      isSelected
                                        ? "bg-brand-50 border-brand-500 text-brand-600 shadow-sm"
                                        : "bg-gray-50 border-gray-100 text-gray-500 hover:text-gray-600 hover:bg-gray-100/50"
                                    }`}
                                  >
                                    <div className={`p-2 rounded-xl ${isSelected ? "bg-brand-100" : "bg-white"}`}>
                                      <Icon className="w-4 h-4" />
                                    </div>
                                    <div>
                                      <span className="block text-xs font-black">{service.label}</span>
                                      <span className="text-[10px] font-bold opacity-80 block">{service.description}</span>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {zones.length > 0 && (
                            <div className="space-y-1.5">
                              <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Work Zone</label>
                              <div className="relative">
                                <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4 pointer-events-none z-10" />
                                <select
                                  value={signupZoneId}
                                  onChange={(e) => setSignupZoneId(e.target.value)}
                                  className="w-full pl-11 pr-10 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all appearance-none"
                                >
                                  <option value="">Select the zone you'll deliver in</option>
                                  {zones.map((zone) => (
                                    <option key={zone._id} value={zone._id}>
                                      {formatZoneLabel(zone.name, zone.city)}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4 pointer-events-none" />
                              </div>
                              <p className="text-[10px] text-gray-400 font-bold ml-1">
                                You'll only be offered deliveries starting in this zone
                              </p>
                            </div>
                          )}

                          <button
                            disabled={checkingPhone}
                            onClick={async () => {
                              const error = validateSignupStep1({
                                signupName,
                                signupPhone,
                                signupEmail,
                                signupAddress,
                                profileImageFile,
                                signupServiceType,
                                zones,
                                signupZoneId,
                              });
                              if (error) {
                                toast.error(error);
                                return;
                              }

                              setCheckingPhone(true);
                              try {
                                const res = await deliveryApi.checkPhone(signupPhone);
                                if (res.data?.result?.registered) {
                                  toast.error(
                                    res.data?.message ||
                                      "This phone number is already registered. Please login instead."
                                  );
                                  return;
                                }
                                setSignupStep(2);
                              } catch (err) {
                                toast.error(
                                  err.response?.data?.message ||
                                    "Couldn't verify phone number. Please try again."
                                );
                              } finally {
                                setCheckingPhone(false);
                              }
                            }}
                            className="w-full py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {checkingPhone ? "Checking..." : "Next Step"} <ArrowRight className="w-4 h-4" />
                          </button>
                        </motion.div>
                      )}

                      {/* Step 2: Vehicle Information */}
                      {signupStep === 2 && (
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-4"
                        >
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Vehicle Type</label>
                            <div className="relative">
                              <Bike className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <button
                                type="button"
                                onClick={() => setShowVehicleDropdown(!showVehicleDropdown)}
                                className="w-full pl-11 pr-10 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none text-left"
                              >
                                {VEHICLE_TYPES.find((v) => v.value === signupVehicle)?.label}
                              </button>
                              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                              <AnimatePresence>
                                {showVehicleDropdown && (
                                  <motion.div
                                    initial={{ opacity: 0, y: -8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -8 }}
                                    className="absolute top-full left-0 w-full bg-white border border-gray-100 rounded-2xl shadow-lg mt-2 overflow-hidden z-20"
                                  >
                                    {VEHICLE_TYPES.map((v) => (
                                      <button
                                        key={v.value}
                                        onClick={() => { setSignupVehicle(v.value); setShowVehicleDropdown(false); }}
                                        className="w-full px-4 py-3 text-sm font-bold text-left hover:bg-brand-50 transition-colors"
                                      >
                                        {v.label}
                                      </button>
                                    ))}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Vehicle Plate Number</label>
                            <div className="relative">
                              <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <input
                                type="text"
                                value={signupVehicleNumber}
                                onChange={(e) => setSignupVehicleNumber(formatVehiclePlate(e.target.value))}
                                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all uppercase"
                                placeholder="KA 05 MN 8921"
                                maxLength={13}
                              />
                            </div>
                            <p className="text-[10px] text-gray-400 font-bold ml-1">Format: 2 letters · 2 digits · 2 letters · 4 digits</p>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Driving License Number</label>
                            <div className="relative">
                              <FileText className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                              <input
                                type="text"
                                value={signupDLNumber}
                                onChange={(e) => setSignupDLNumber(formatDrivingLicense(e.target.value))}
                                className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all uppercase"
                                placeholder="DL-1420110012345"
                                maxLength={16}
                              />
                            </div>
                            <p className="text-[10px] text-gray-400 font-bold ml-1">Format: DL- followed by 13 digits</p>
                          </div>

                          <div className="flex gap-4 pt-2">
                            <button
                              onClick={() => setSignupStep(1)}
                              className="flex-1 py-4 bg-gray-100 text-gray-600 rounded-2xl text-sm font-black uppercase tracking-widest hover:bg-gray-200 transition-all"
                            >
                              Back
                            </button>
                            <button
                              onClick={() => {
                                const error = validateSignupStep2({ signupVehicleNumber, signupDLNumber });
                                if (error) {
                                  toast.error(error);
                                  return;
                                }
                                setSignupStep(3);
                              }}
                              className="flex-[2] py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all flex items-center justify-center gap-2"
                            >
                              Next Step <ArrowRight className="w-4 h-4" />
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {/* Step 3: Bank Information */}
                      {signupStep === 3 && (
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-4"
                        >
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Aadhar Number</label>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={signupAadharNumber}
                              onChange={(e) => setSignupAadharNumber(e.target.value.replace(/\D/g, "").slice(0, 12))}
                              className="w-full px-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all font-mono"
                              placeholder="0000 0000 0000"
                              maxLength={12}
                            />
                            <p className="text-[10px] text-gray-400 font-bold ml-1">12 digits only</p>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">PAN Card Number</label>
                            <input
                              type="text"
                              value={signupPanNumber}
                              onChange={(e) => setSignupPanNumber(formatPanNumber(e.target.value))}
                              className="w-full px-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all font-mono uppercase"
                              placeholder="ABCDE1234F"
                              maxLength={10}
                            />
                            <p className="text-[10px] text-gray-400 font-bold ml-1">Format: 5 letters · 4 digits · 1 letter</p>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Account Holder Name</label>
                            <input
                              type="text"
                              value={signupAccountHolder}
                              onChange={(e) => setSignupAccountHolder(e.target.value.toUpperCase())}
                              className="w-full px-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all"
                              placeholder="AS PER BANK RECORDS"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">Account Number</label>
                            <input
                              type="text"
                              value={signupAccountNumber}
                              onChange={(e) => setSignupAccountNumber(e.target.value.replace(/\D/g, ""))}
                              className="w-full px-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all"
                              placeholder="000000000000"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">IFSC Code</label>
                            <input
                              type="text"
                              value={signupIfsc}
                              onChange={(e) => setSignupIfsc(e.target.value.toUpperCase())}
                              className="w-full px-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all"
                              placeholder="HDFC0001234"
                            />
                          </div>

                          <div className="flex gap-4 pt-2">
                            <button
                              onClick={() => setSignupStep(2)}
                              className="flex-1 py-4 bg-gray-100 text-gray-600 rounded-2xl text-sm font-black uppercase tracking-widest hover:bg-gray-200 transition-all"
                            >
                              Back
                            </button>
                            <button
                              onClick={() => {
                                const error = validateSignupStep3({
                                  signupAadharNumber,
                                  signupPanNumber,
                                  signupAccountHolder,
                                  signupAccountNumber,
                                  signupIfsc,
                                });
                                if (error) {
                                  toast.error(error);
                                  return;
                                }
                                setSignupStep(4);
                              }}
                              className="flex-[2] py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all flex items-center justify-center gap-2"
                            >
                              Next Step <ArrowRight className="w-4 h-4" />
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {/* Step 4: Documents Upload */}
                      {signupStep === 4 && (
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-4"
                        >
                          <div className="space-y-3">
                            {[
                              { label: "Aadhar Card (Front)", state: aadharFrontFile, setter: setAadharFrontFile, id: "aadharFront" },
                              { label: "Aadhar Card (Back)", state: aadharBackFile, setter: setAadharBackFile, id: "aadharBack" },
                              { label: "PAN Card", state: panFile, setter: setPanFile, id: "pan" },
                              { label: "Driving License", state: dlFile, setter: setDlFile, id: "dl" },
                            ].map((doc) => (
                              <div key={doc.id} className="relative">
                                <input
                                  type="file"
                                  id={doc.id}
                                  className="hidden"
                                  accept="image/*"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0] || null;
                                    if (doc.id === "aadharFront") handleAadharFrontUpload(file);
                                    else if (doc.id === "aadharBack") handleAadharBackUpload(file);
                                    else if (doc.id === "pan") handlePanUpload(file);
                                    else if (doc.id === "dl") handleDLUpload(file);
                                  }}
                                />
                                <label
                                  htmlFor={doc.id}
                                  className={`flex items-center justify-between p-4 rounded-2xl border-2 border-dashed transition-all cursor-pointer ${doc.state
                                    ? "border-brand-200 bg-brand-50/50"
                                    : "border-gray-100 bg-gray-50 hover:border-brand-200 hover:bg-brand-50/30"
                                    }`}
                                >
                                  <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-xl ${doc.state ? "bg-brand-100 text-brand-600" : "bg-white text-gray-400 shadow-sm"}`}>
                                      {doc.state ? <CheckCircle className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                                    </div>
                                    <div className="text-left">
                                      <p className={`text-xs font-black uppercase tracking-tight ${doc.state ? "text-brand-700" : "text-gray-500"}`}>
                                        {doc.label}
                                      </p>
                                      <p className="text-[10px] text-gray-400 font-bold truncate max-w-[180px]">
                                        {doc.state ? doc.state.name : "Tap to upload document"}
                                      </p>
                                    </div>
                                  </div>
                                  {doc.state && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        doc.setter(null);
                                      }}
                                      className="p-1.5 hover:bg-brand-100 rounded-lg text-brand-600 transition-colors"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </label>
                              </div>
                            ))}
                            <p className="text-[10px] text-gray-400 italic px-1 flex items-center gap-1.5">
                              <ShieldCheck className="w-3 h-3 text-brand-300" />
                              Documents will be verified by our team after submission.
                            </p>
                          </div>

                          <div className="flex gap-3">
                            <button
                              onClick={() => setSignupStep(3)}
                              className="flex-1 py-4 bg-gray-100 text-gray-600 rounded-2xl text-sm font-black uppercase tracking-widest hover:bg-gray-200 transition-all"
                            >
                              Back
                            </button>
                            <button
                              onClick={handleSendOtp}
                              disabled={loading || !dlFile || !panFile || !aadharFrontFile || !aadharBackFile}
                              className="flex-[2] py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {loading ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              ) : (
                                <>
                                  Register <ArrowRight className="w-4 h-4" />
                                </>
                              )}
                            </button>
                          </div>
                        </motion.div>
                      )}

                      <p className="text-center text-xs text-gray-400 font-semibold pt-1">
                        By joining, you agree to our{" "}
                        <span className="text-brand-500 font-bold cursor-pointer hover:underline" onClick={() => setLegalKind("terms")}>Terms</span>{" "}
                        &amp;{" "}
                        <span className="text-brand-500 font-bold cursor-pointer hover:underline" onClick={() => setLegalKind("privacy")}>Privacy Policy</span>
                      </p>
                    </div>
                  )}

                  {/* ────────── LOGIN MODE ────────── */}
                  {mode === "login" && (
                    <div className="space-y-4">
                      {/* Phone */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-black text-gray-400 uppercase tracking-widest ml-1">
                          Phone Number
                        </label>
                        <div className="relative">
                          <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                          <span className="absolute left-10 top-1/2 -translate-y-1/2 text-gray-500 font-bold text-sm border-r border-gray-200 pr-2.5">
                            +91
                          </span>
                          <input
                            type="tel"
                            value={loginPhone}
                            onChange={(e) => {
                              const val = e.target.value.replace(/\D/g, "").slice(0, 10);
                              setLoginPhone(val);
                            }}
                            maxLength={10}
                            className="w-full pl-24 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-400 transition-all placeholder:text-gray-300"
                            placeholder="00000 00000"
                          />
                        </div>
                      </div>

                      <button
                        onClick={handleSendOtp}
                        disabled={loading}
                        className="w-full py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-60"
                      >
                        {loading ? (
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <>Login Now <ArrowRight className="w-4 h-4" /></>
                        )}
                      </button>

                      {/* CAR WASH DISABLED — partner login link
                      <div className="text-center pt-4 border-t border-gray-100 mt-4">
                        <button
                          type="button"
                          onClick={() => navigate("/car-wash/partner/auth")}
                          className="text-xs font-black text-brand-600 hover:text-brand-700 hover:underline flex items-center justify-center gap-1.5 mx-auto transition-all"
                        >
                          <Sparkles size={14} className="text-cyan-500 animate-pulse" />
                          Are you a Car Wash Partner? Click here
                        </button>
                      </div>
                      */}
                    </div>
                  )}
                </motion.div>
              )}

              {/* ─── OTP STEP ─── */}
              {step === "otp" && (
                <motion.div
                  key="otp"
                  variants={slideVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="space-y-5"
                >
                  {/* OTP Boxes */}
                  <div className="space-y-2 text-center">
                    <label className="text-xs font-black text-gray-400 uppercase tracking-widest">
                      Enter Security Code
                    </label>
                    <div className="flex justify-center gap-3 pt-1">
                      {otp.map((digit, index) => (
                        <input
                          key={index}
                          id={`otp-${index}`}
                          type="tel"
                          maxLength={1}
                          value={digit}
                          onChange={(e) => handleOtpChange(index, e.target.value)}
                          onKeyDown={(e) => handleKeyDown(index, e)}
                          className="w-14 h-14 text-center text-2xl font-black border-2 border-gray-100 rounded-2xl focus:border-brand-500 focus:ring-4 focus:ring-brand-100 outline-none transition-all bg-gray-50 text-gray-900"
                        />
                      ))}
                    </div>
                  </div>

                  {/* Timer / Resend */}
                  <div className="text-center">
                    {timer > 0 ? (
                      <p className="text-gray-400 text-sm font-medium">
                        Resend code in <span className="text-brand-600 font-bold">{timer}s</span>
                      </p>
                    ) : (
                      <button
                        onClick={handleSendOtp}
                        className="text-brand-600 font-black text-sm uppercase tracking-wide hover:underline"
                      >
                        Resend OTP
                      </button>
                    )}
                  </div>

                  {/* Terms checkbox */}
                  <div className="flex items-start gap-3 bg-gray-50 rounded-2xl p-4 border border-gray-100">
                    <input
                      id="terms"
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-brand-600 cursor-pointer"
                    />
                    <label htmlFor="terms" className="text-xs text-gray-500 leading-relaxed cursor-pointer">
                      I confirm my phone number is correct and I agree to the{" "}
                      <span className="text-brand-600 font-bold cursor-pointer hover:underline" onClick={() => setLegalKind("terms")}>Terms of Service</span> &amp;{" "}
                      <span className="text-brand-600 font-bold cursor-pointer hover:underline" onClick={() => setLegalKind("privacy")}>Privacy Policy</span>.
                    </label>
                  </div>

                  {/* Verify Button */}
                  <button
                    onClick={handleVerifyOtp}
                    disabled={!agreed || otp.some((d) => !d) || loading}
                    className="w-full py-4 bg-black  text-primary-foreground rounded-2xl text-sm font-black tracking-widest uppercase shadow-lg shadow-brand-200 hover:bg-brand-700 hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>Verify &amp; Login <CheckCircle className="w-4 h-4" /></>
                    )}
                  </button>

                  {/* Back */}
                  <button
                    onClick={() => { setStep("form"); setOtp(["", "", "", ""]); }}
                    className="w-full flex items-center justify-center gap-1.5 text-gray-400 hover:text-gray-600 text-sm font-bold transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" /> Edit Phone Number
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-center gap-3 opacity-40">
          <span className="h-px w-8 bg-gray-400" />
          <ShieldCheck className="text-gray-500 w-4 h-4" />
          <span className="h-px w-8 bg-gray-400" />
        </div>
        <p className="text-center text-[10px] font-black text-gray-300 uppercase tracking-[4px] mt-2">
          {appName} Partner Ecosystem • v1.0
        </p>
      </motion.div>

      <LegalSheet
        audience="delivery"
        kind={legalKind}
        onClose={() => setLegalKind(null)}
        onAccept={() => setLegalKind(null)}
      />
    </div>
  );
};

export default DeliveryAuth;
