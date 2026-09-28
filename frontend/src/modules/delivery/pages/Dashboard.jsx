import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Bell,
  Star,
  TrendingUp,
  Package,
  MapPin,
  CheckCircle,
  XCircle,
  IndianRupee,
  AlertCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import Button from "@/shared/components/ui/Button";
import Card from "@/shared/components/ui/Card";

import { useAuth } from "@core/context/AuthContext";
import { deliveryApi } from "../services/deliveryApi";
import CashLimitBanner from "../components/CashLimitBanner";
import { parcelApi } from "../../customer/services/parcelApi";

const Dashboard = () => {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [isOnline, setIsOnline] = useState(user?.isOnline || false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [assignedParcel, setAssignedParcel] = useState(null);
  const [earnings, setEarnings] = useState({
    today: 0,
    deliveries: 0,
    incentives: 0,
    cashCollected: 0,
  });
  const assignedParcelRequestRef = useRef({
    inFlight: false,
    lastFetchedAt: 0,
  });
  const profileImage = useMemo(() => {
    if (user?.profileImage) return user.profileImage;
    const seed = encodeURIComponent(user?.name || user?.phone || "delivery");
    return `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
  }, [user?.profileImage, user?.name, user?.phone]);

  const partnerIdShort = useMemo(
    () => String(user?._id || user?.id || "").slice(-6).toUpperCase() || "N/A",
    [user?._id, user?.id],
  );

  // Sync isOnline with user profile from context
  useEffect(() => {
    if (user) {
      setIsOnline(user.isOnline);
    }
  }, [user]);

  const fetchStats = async () => {
    try {
      const response = await deliveryApi.getStats();
      if (response.data.success) {
        setEarnings((prev) => ({
          ...prev,
          ...response.data.result,
        }));
      }
    } catch (error) {
      console.error("Failed to fetch statistics:", error);
    }
  };

  const fetchNotifications = async () => {
    try {
      const response = await deliveryApi.getNotifications();
      if (response.data.success && response.data.result) {
        setUnreadCount(response.data.result.unreadCount || 0);
      }
    } catch (error) {
      console.error("Failed to fetch notifications");
    }
  };

  const fetchAssignedParcel = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - assignedParcelRequestRef.current.lastFetchedAt < 30000)
      return;
    if (assignedParcelRequestRef.current.inFlight) return;
    assignedParcelRequestRef.current.inFlight = true;
    try {
      const res = await parcelApi.riderGetAssigned({
        ttl: 30000,
        forceRefresh: force,
      });
      if (!res.data?.success) return;
      const list = res.data.results || res.data.result || [];
      const active = list.find(
        (p) => p.status && !["DELIVERED", "CANCELLED"].includes(p.status),
      );
      setAssignedParcel(active || null);
    } catch {
      setAssignedParcel(null);
    } finally {
      assignedParcelRequestRef.current.inFlight = false;
      assignedParcelRequestRef.current.lastFetchedAt = Date.now();
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchNotifications();
  }, []);

  useEffect(() => {
    if (isOnline) {
      fetchAssignedParcel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: avoid user-object churn
  }, [isOnline, fetchAssignedParcel]);

  const handleOnlineToggle = async () => {
    const newStatus = !isOnline;
    try {
      await deliveryApi.updateProfile({ isOnline: newStatus });
      await refreshUser(); // Refresh global auth state
      setIsOnline(newStatus);
      if (newStatus) {
        toast.success("You are now ONLINE. Finding parcel jobs...");
      } else {
        toast.info("You are now OFFLINE. No new jobs.");
      }
    } catch (error) {
      toast.error("Failed to update status");
    }
  };

  return (
    <div className="bg-gray-50/50 min-h-screen pb-24 relative overflow-hidden font-sans">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 pt-12 pb-4 flex justify-between items-center sticky top-0 z-30 transition-all duration-300">
        <div className="flex items-center space-x-3">
          <div
            className="w-12 h-12 rounded-full overflow-hidden border-2 border-primary ring-2 ring-primary/20 shadow-sm cursor-pointer"
            onClick={() => navigate("/delivery/profile")}>
            <img
              src={profileImage}
              alt="Profile"
              className="w-full h-full object-cover"
            />
          </div>
          <div
            onClick={() => navigate("/delivery/profile")}
            className="cursor-pointer">
            <h2 className="ds-h2 leading-tight">
              {user?.name || "Delivery Partner"}
            </h2>
            <div className="flex items-center text-sm font-medium">
              {user?.rating ? (
                <span className="flex items-center bg-yellow-50 text-yellow-600 px-1.5 py-0.5 rounded border border-yellow-100">
                  <Star size={12} fill="currentColor" className="mr-1" />
                  {Number(user.rating).toFixed(1)}
                </span>
              ) : null}
              {user?.rating ? (
                <span className="text-gray-300 mx-2">•</span>
              ) : null}
              <span className="ds-caption text-gray-500">ID: {partnerIdShort}</span>
            </div>
          </div>
        </div>
        <div
          className="relative p-2.5 bg-gray-50 border border-gray-100 rounded-full hover:bg-gray-100 transition-colors cursor-pointer group"
          onClick={() => navigate("/delivery/notifications")}>
          <Bell
            size={20}
            className="text-gray-600 group-hover:text-primary transition-colors"
          />
          {unreadCount > 0 && (
            <span className="absolute top-2 right-2.5 w-2 h-2 bg-red-500 border-2 border-white rounded-full animate-pulse"></span>
          )}
        </div>
      </header>

      {/* Online/Offline Toggle */}
      <div className="px-6 py-6">
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-gray-100 group">
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">
              Service Status
            </span>
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full animate-pulse",
                  isOnline
                    ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                    : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]",
                )}
              />
              <span
                className={cn(
                  "text-[11px] font-bold uppercase tracking-wider",
                  isOnline ? "text-emerald-600" : "text-rose-600",
                )}>
                {isOnline ? "Receiving Jobs" : "Currently Offline"}
              </span>
            </div>
          </div>

          <div
            className="relative w-full h-14 bg-gray-100/80 rounded-2xl flex items-center p-1.5 cursor-pointer shadow-inner overflow-hidden border border-gray-200/50"
            onClick={handleOnlineToggle}>
            {/* Background Labels */}
            <div className="absolute inset-0 flex w-full">
              <div className="w-1/2 flex items-center justify-center">
                <span
                  className={cn(
                    "text-[10px] font-black tracking-widest transition-opacity duration-300",
                    isOnline ? "opacity-0" : "opacity-40 text-gray-500",
                  )}>
                  SLIDE TO GO ONLINE
                </span>
              </div>
              <div className="w-1/2 flex items-center justify-center">
                <span
                  className={cn(
                    "text-[10px] font-black tracking-widest transition-opacity duration-300",
                    !isOnline ? "opacity-0" : "opacity-40 text-gray-500",
                  )}>
                  SLIDE TO GO OFFLINE
                </span>
              </div>
            </div>

            <motion.div
              drag="x"
              dragConstraints={{ left: 0, right: 0 }} // We will use dragElastic for feel, but onDragEnd for logic
              dragElastic={0.1}
              onDragEnd={(_, info) => {
                const swipePower = info.offset.x;
                if (swipePower > 50 && !isOnline) {
                  handleOnlineToggle();
                } else if (swipePower < -50 && isOnline) {
                  handleOnlineToggle();
                }
              }}
              whileTap={{ scale: 0.98 }}
              className={cn(
                "w-1/2 h-full rounded-xl shadow-md flex items-center justify-center gap-2 z-10 border transition-all duration-500 cursor-grab active:cursor-grabbing",
                isOnline
                  ? "bg-gradient-to-r from-primary to-[var(--brand-400)] border-[#389ecb] text-white"
                  : "bg-gradient-to-r from-slate-700 to-slate-800 border-slate-900 text-white",
              )}
              animate={{ x: isOnline ? "100%" : "0%" }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}>
              <motion.div
                initial={false}
                animate={{ rotate: isOnline ? 0 : 0 }}>
                {isOnline ? (
                  <CheckCircle size={18} strokeWidth={3} />
                ) : (
                  <XCircle size={18} strokeWidth={3} />
                )}
              </motion.div>
              <span className="text-xs font-black uppercase tracking-widest select-none">
                {isOnline ? "ONLINE" : "OFFLINE"}
              </span>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-6 space-y-6">
        {/* A cash-limit block would otherwise look identical to a quiet
            afternoon: the feed comes back empty either way. */}
        {isOnline && <CashLimitBanner className="mb-3" />}

        {assignedParcel && (
          <Card className="bg-brand-50/50 border border-brand-100 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-brand-600">
                  Active Parcel Task
                </p>
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="text-[10px] font-black uppercase tracking-wider text-brand-600">
                    Active Parcel Task
                  </p>
                  {assignedParcel.courierCompanyId?.name ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-700">
                      📦 Drop at {assignedParcel.courierCompanyId.name}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-emerald-700">
                      📦 Deliver to Receiver
                    </span>
                  )}
                </div>
                <p className="text-sm font-bold text-slate-900">
                  Continue parcel workflow
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Status: {assignedParcel.status}
                </p>
                {assignedParcel.deliverySpeed === "express" ? (
                  <span className="mt-1.5 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-800">
                    Express · 10 min
                  </span>
                ) : (
                  <span className="mt-1.5 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-600">
                    Normal · 30 min
                  </span>
                )}
                {String(assignedParcel.paymentMethod).toUpperCase() ===
                  "COD" && (
                  <p className="text-xs font-black text-amber-700 mt-1.5">
                    Collect COD ₹
                    {Number(
                      assignedParcel.codSettlement?.collectAmount ||
                        assignedParcel.fare ||
                        0,
                    ).toFixed(2)}
                  </p>
                )}
                {assignedParcel.riderEarningBreakdown?.earning > 0 && (
                  <p className="text-xs font-black text-emerald-700 mt-1.5">
                    You earn ₹
                    {assignedParcel.riderEarningBreakdown.earning.toFixed(2)}{" "}
                    <span className="font-semibold text-emerald-600">
                      ({assignedParcel.riderEarningBreakdown.distanceKm} km × ₹
                      {assignedParcel.riderEarningBreakdown.ratePerKm}/km)
                    </span>
                  </p>
                )}
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  navigate(`/delivery/parcel-task/${assignedParcel._id}`)
                }
                className="h-9 px-3 text-[11px] font-black uppercase tracking-wider">
                Open
              </Button>
            </div>
          </Card>
        )}

        {/* Earnings Card */}
        <Card className="bg-white shadow-sm border border-gray-100 overflow-hidden relative">
          {/* Background Decoration */}
          <div className="absolute -right-6 -top-6 w-24 h-24 bg-primary/5 rounded-full blur-2xl"></div>

          <div className="flex justify-between items-center mb-4 relative z-10">
            <h3 className="ds-caption font-bold tracking-wider">
              Today's Earnings
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/delivery/earnings")}
              className="text-primary hover:text-primary/80 hover:bg-primary/5 h-8 px-3 text-xs font-bold rounded-full">
              View Details
            </Button>
          </div>

          <div className="flex items-baseline mb-6 relative z-10">
            <span className="text-2xl font-bold text-gray-400 mr-1">₹</span>
            <span className="text-4xl font-extrabold text-gray-900 tracking-tight">
              {earnings.today}
            </span>
            <span className="ml-3 text-brand-600 text-xs font-bold flex items-center bg-brand-50 border border-brand-100 px-2 py-1 rounded-full">
              <TrendingUp size={12} className="mr-1" /> +12%
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 border-t border-gray-50 pt-4 relative z-10">
            <div className="text-center group cursor-pointer">
              <div className="flex justify-center mb-2 text-brand-600 bg-brand-50 group-hover:bg-brand-100 transition-colors w-10 h-10 rounded-full items-center mx-auto">
                <Package size={18} />
              </div>
              <p className="ds-caption mb-0.5">Deliveries</p>
              <p className="font-bold text-gray-900">{earnings.deliveries}</p>
            </div>
            <div className="text-center border-l border-r border-gray-50 group cursor-pointer">
              <div className="flex justify-center mb-2 text-amber-500 bg-amber-50 group-hover:bg-amber-100 transition-colors w-10 h-10 rounded-full items-center mx-auto">
                <Star size={18} />
              </div>
              <p className="ds-caption mb-0.5">Incentives</p>
              <p className="font-bold text-gray-900">₹{earnings.incentives}</p>
            </div>
            <div
              className="text-center group cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => navigate("/delivery/porter-cash")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  navigate("/delivery/porter-cash");
              }}>
              <div className="flex justify-center mb-2 text-brand-600 bg-brand-50 group-hover:bg-brand-100 transition-colors w-10 h-10 rounded-full items-center mx-auto">
                <IndianRupee size={18} />
              </div>
              <p className="ds-caption mb-0.5">Cash in Hand</p>
              <p className="font-bold text-gray-900">
                ₹{earnings.cashCollected}
              </p>
            </div>
          </div>
        </Card>

        {/* Job status */}
        <AnimatePresence mode="wait">
          {!isOnline ? (
            <motion.div
              key="offline"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="bg-white rounded-2xl p-8 text-center shadow-sm border border-gray-100">
              <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-6 border border-gray-100">
                <AlertCircle size={32} className="text-gray-400" />
              </div>
              <h3 className="ds-h3 mb-2">You are Offline</h3>
              <p className="text-sm text-gray-500 max-w-[250px] mx-auto">
                Go online to start receiving parcel jobs and earning money.
              </p>
            </motion.div>
          ) : !assignedParcel ? (
            <motion.div
              key="searching"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-gray-200 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-tr from-brand-50/50 to-purple-50/50 opacity-50"></div>
              <div className="relative z-10">
                <div className="relative w-24 h-24 mx-auto mb-6">
                  <div className="absolute inset-0 bg-brand-100 rounded-full animate-ping opacity-20"></div>
                  <div className="absolute inset-2 bg-brand-100 rounded-full animate-ping opacity-40 delay-150"></div>
                  <div className="relative w-full h-full bg-brand-50 rounded-full flex items-center justify-center border border-brand-100 shadow-sm">
                    <MapPin size={36} className="text-brand-600" />
                  </div>
                </div>
                <h3 className="ds-h3 mb-2 text-gray-800">
                  Searching for Parcel Jobs...
                </h3>
                <p className="text-sm text-gray-500 max-w-[220px] mx-auto mb-6">
                  We're looking for parcel jobs in your area. Stay online!
                </p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default Dashboard;
