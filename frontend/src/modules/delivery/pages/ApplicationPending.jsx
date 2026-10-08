import React, { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { CheckCircle2, Clock3, RefreshCw, ShieldAlert, Truck } from "lucide-react";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import { toast } from "sonner";
import { deliveryApi } from "../services/deliveryApi";
import { vehicleTypeLabel, displayPlate } from "../utils/vehicleRules";

/** The rows of a pending vehicle change: what it was and what it is becoming. */
const vehicleChangeRows = (change) => {
  const { previous = {}, requested = {} } = change || {};
  const rows = [];
  if (requested.vehicleType) {
    rows.push(["Vehicle type", vehicleTypeLabel(previous.vehicleType), vehicleTypeLabel(requested.vehicleType)]);
  }
  if (requested.vehicleNumber) {
    rows.push(["Plate number", displayPlate(previous.vehicleNumber), displayPlate(requested.vehicleNumber)]);
  }
  if (requested.drivingLicenseNumber) {
    rows.push(["Driving license", previous.drivingLicenseNumber || "—", requested.drivingLicenseNumber]);
  }
  return rows;
};

const ApplicationPending = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, role, user, isLoading, refreshUser } = useAuth();
  const { settings } = useSettings();
  const [cancelling, setCancelling] = useState(false);

  const appName = settings?.appName || "App";
  const logoUrl = settings?.logoUrl || "";

  const applicationStatus =
    location.state?.applicationStatus ||
    user?.applicationStatus ||
    (user?.isVerified ? "approved" : "pending");
  const rejectionReason = location.state?.rejectionReason || user?.rejectionReason || "";

  if (!isLoading && isAuthenticated && role === "delivery") {
    if (user?.isVerified === true) {
      return <Navigate to="/delivery/dashboard" replace />;
    }
  }

  const isRejected = applicationStatus === "rejected";
  // An approved rider whose vehicle change is waiting on the admin — not a new applicant.
  const vehicleChange = user?.vehicleChange?.status === "pending" ? user.vehicleChange : null;

  const handleCancelVehicleChange = async () => {
    if (!window.confirm("Cancel this vehicle change and go back to your current vehicle details?")) return;
    setCancelling(true);
    try {
      await deliveryApi.cancelVehicleChange();
      const updated = await refreshUser();
      toast.success("Vehicle change cancelled. Your account is active again.");
      if (updated?.isVerified) window.location.href = "/delivery/dashboard";
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not cancel the change");
    } finally {
      setCancelling(false);
    }
  };

  const handleRefreshStatus = async () => {
    const updated = await refreshUser();
    if (updated?.isVerified) {
      toast.success("Your account has been approved!");
      window.location.href = "/delivery/dashboard";
      return;
    }
    toast.info("Your application is still under review. Please check back later.");
  };

  return (
    <div className="min-h-screen bg-slate-950 relative overflow-hidden font-['Outfit']">
      <div className="absolute inset-0">
        <div className="absolute top-[-20%] right-[-10%] h-[420px] w-[420px] rounded-full bg-amber-400/10 blur-3xl" />
        <div className="absolute bottom-[-20%] left-[-10%] h-[420px] w-[420px] rounded-full bg-brand-400/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-10">
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="w-full rounded-3xl border border-white/10 bg-white/[0.04] p-6 md:p-10 shadow-2xl backdrop-blur-xl"
        >
          <div className="mb-8 flex items-center justify-between gap-4">
            <div className="inline-flex items-center gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-2">
              {logoUrl ? (
                <img src={logoUrl} alt={`${appName} logo`} className="h-8 w-8 object-contain" />
              ) : (
                <Truck className="h-5 w-5 text-white/80" />
              )}
              <span className="text-sm font-bold text-white/90">{appName} Delivery</span>
            </div>
            <div
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-black uppercase tracking-widest ${
                isRejected
                  ? "bg-rose-500/20 text-rose-200"
                  : "bg-amber-400/20 text-amber-100"
              }`}
            >
              {isRejected ? <ShieldAlert className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
              {isRejected ? "Application Rejected" : vehicleChange ? "Vehicle Change Pending" : "Application Pending"}
            </div>
          </div>

          <h1 className="text-3xl md:text-4xl font-black text-white leading-tight">
            {isRejected
              ? "Your delivery partner application needs action."
              : vehicleChange
                ? "Your vehicle change is waiting for approval."
                : "Your delivery partner application is under review."}
          </h1>
          <p className="mt-4 text-base md:text-lg text-slate-200/90 font-medium max-w-2xl">
            {isRejected
              ? "Read the reason below, update your details, and reapply. The admin will review it again."
              : vehicleChange
                ? "Your account is on hold while the admin reviews your new vehicle details. You will be able to go online again as soon as it is approved."
                : "You will start receiving orders only after admin approves your account."}
          </p>

          {vehicleChange ? (
            <div className="mt-6 rounded-2xl border border-white/15 bg-white/5 p-4">
              <p className="text-[11px] font-black uppercase tracking-widest text-white/60">What you asked to change</p>
              <div className="mt-3 divide-y divide-white/10">
                {vehicleChangeRows(vehicleChange).map(([label, from, to]) => (
                  <div key={label} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="font-semibold text-white/70">{label}</span>
                    <span className="font-bold text-white">
                      <span className="text-white/50 line-through">{from}</span>
                      <span className="mx-2 text-amber-300">→</span>
                      {to}
                    </span>
                  </div>
                ))}
              </div>
              {vehicleChange.requestedAt ? (
                <p className="mt-3 text-xs text-white/50">
                  Requested on {new Date(vehicleChange.requestedAt).toLocaleString("en-IN")}
                </p>
              ) : null}
            </div>
          ) : null}

          {rejectionReason ? (
            <div className="mt-6 rounded-2xl border border-rose-300/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
              <span className="font-black uppercase tracking-widest text-[11px]">Reason</span>
              <p className="mt-1 font-medium">{rejectionReason}</p>
            </div>
          ) : null}

          {!isRejected && !vehicleChange && user?.reappliedAt ? (
            <div className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100">
              Your reapplication was sent on {new Date(user.reappliedAt).toLocaleDateString("en-IN")}. The admin will review it again.
            </div>
          ) : null}

          {!isRejected ? (
            <div className="mt-6 rounded-2xl border border-brand-400/30 bg-brand-500/10 px-4 py-3 text-sm text-brand-200 flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0 text-brand-400" />
              <p className="font-semibold">
                Approval usually takes less than 24 hours. You will not receive any order requests until your account is activated.
              </p>
            </div>
          ) : null}

          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            {isRejected ? (
              <button
                type="button"
                onClick={() => navigate("/delivery/auth", { state: { reapplyFrom: user } })}
                className="inline-flex items-center justify-center rounded-xl bg-orange-500 text-white px-5 py-3 text-sm font-black tracking-wide hover:bg-orange-600 transition-colors"
              >
                Edit & reapply
              </button>
            ) : null}
            {vehicleChange ? (
              <button
                type="button"
                onClick={handleCancelVehicleChange}
                disabled={cancelling}
                className="inline-flex items-center justify-center rounded-xl border border-amber-300/40 bg-amber-400/10 text-amber-100 px-5 py-3 text-sm font-black tracking-wide hover:bg-amber-400/20 transition-colors disabled:opacity-60"
              >
                {cancelling ? "Cancelling…" : "Cancel change request"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleRefreshStatus}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-white text-slate-900 px-5 py-3 text-sm font-black tracking-wide hover:bg-slate-100 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Check Approval Status
            </button>
            <Link
              to="/delivery/auth"
              className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 text-white px-5 py-3 text-sm font-bold hover:bg-white/10 transition-colors"
            >
              Back To Delivery Login
            </Link>
            <Link
              to="/"
              className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 text-white px-5 py-3 text-sm font-bold hover:bg-white/10 transition-colors"
            >
              Go To Home
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default ApplicationPending;
