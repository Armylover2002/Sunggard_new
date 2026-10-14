import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft,
  RefreshCw,
  MapPin,
  Navigation,
  IndianRupee,
  AlertCircle,
  Clock,
  Inbox,
} from "lucide-react";
import Card from "@/shared/components/ui/Card";
import Button from "@/shared/components/ui/Button";
import { parcelApi } from "../../customer/services/parcelApi";
import { onOpenBookingsChanged } from "@/core/services/orderSocket";
import { createSocketTokenReader } from "@core/utils/authStorage";
import { STORAGE_KEYS } from "@core/utils/storage";
import { useAuth } from "@core/context/AuthContext";

const getDeliveryToken = createSocketTokenReader(STORAGE_KEYS.AUTH_DELIVERY);
const displayIdOf = (id) => `PCL-${String(id || "").slice(-6).toUpperCase()}`;
const POLL_MS = 20000;

/**
 * Every booking still looking for a rider in this rider's area. Separate
 * from the one-at-a-time offer popup: here the rider sees the whole list and
 * may accept any of them. The first rider to accept gets it, and it drops off
 * everyone else's list (socket `parcel:open:changed` triggers a refetch).
 */
const OpenBookings = () => {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState({
    bookings: [],
    canAccept: false,
    willQueue: false,
    blockedReason: null,
  });
  const [loading, setLoading] = useState(true);
  const [acceptingId, setAcceptingId] = useState(null);
  const inFlightRef = useRef(false);
  const refetchTimerRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const res = await parcelApi.riderGetOpenBookings();
      const result = res?.data?.result || {};
      setState({
        bookings: Array.isArray(result.bookings) ? result.bookings : [],
        canAccept: Boolean(result.canAccept),
        willQueue: Boolean(result.willQueue),
        blockedReason: result.blockedReason || null,
      });
    } catch (error) {
      if (!silent) {
        toast.error(error.response?.data?.message || "Could not load open bookings");
      }
    } finally {
      inFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, user?.isOnline]);

  // Poll while visible, as a safety net for missed socket events.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load({ silent: true });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A booking opened, was taken by someone else, or was cancelled.
  useEffect(() => {
    return onOpenBookingsChanged(getDeliveryToken, () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => load({ silent: true }), 400);
    });
  }, [load]);

  useEffect(
    () => () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    },
    [],
  );

  const handleAccept = async (booking) => {
    if (acceptingId) return;
    const parcelId = String(booking._id);
    setAcceptingId(parcelId);
    try {
      const idem =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}`;
      const res = await parcelApi.riderAcceptOpenBooking(parcelId, idem);
      await refreshUser().catch(() => {});
      if (res?.data?.result?.isQueued) {
        toast.success("Accepted — added to your waiting list.");
        load({ silent: true });
      } else {
        toast.success("Booking accepted");
        navigate(`/delivery/parcel-task/${parcelId}`);
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Could not accept this booking");
      load({ silent: true });
    } finally {
      setAcceptingId(null);
    }
  };

  const { bookings, canAccept, willQueue, blockedReason } = state;

  return (
    <div className="bg-gray-50/50 min-h-screen pb-24 font-sans">
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 px-4 pt-12 pb-4 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/delivery/dashboard")}
            className="h-10 w-10 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center"
            aria-label="Back">
            <ArrowLeft size={18} className="text-gray-700" />
          </button>
          <div>
            <h2 className="ds-h2 leading-tight">Open bookings</h2>
            <p className="text-xs text-gray-500">Bookings in your area waiting for a rider</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="h-10 w-10 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center"
          aria-label="Refresh">
          <RefreshCw size={18} className={loading ? "animate-spin text-primary" : "text-gray-600"} />
        </button>
      </header>

      <div className="px-4 py-4 space-y-3">
        {blockedReason ? (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3">
            <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs font-semibold text-amber-800">{blockedReason}</p>
          </div>
        ) : willQueue ? (
          <div className="flex items-start gap-2 rounded-2xl border border-brand-100 bg-brand-50 p-3">
            <Clock size={16} className="text-brand-600 mt-0.5 shrink-0" />
            <p className="text-xs font-semibold text-brand-700">
              You are on a delivery. A booking you accept goes to your waiting list — start it
              after your current delivery.
            </p>
          </div>
        ) : null}

        {loading && !bookings.length ? (
          <div className="py-16 text-center text-sm font-semibold text-gray-400">
            Loading open bookings...
          </div>
        ) : !bookings.length ? (
          <div className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-gray-200">
            <Inbox size={32} className="text-gray-300 mx-auto mb-3" />
            <h3 className="ds-h3 mb-1 text-gray-800">No open bookings nearby</h3>
            <p className="text-sm text-gray-500">New bookings in your area will show up here.</p>
          </div>
        ) : (
          bookings.map((booking) => {
            const id = String(booking._id);
            const isCod = String(booking.paymentMethod || "").toUpperCase() === "COD";
            const collect = Number(booking.codSettlement?.collectAmount || booking.payableFare || booking.fare || 0);
            return (
              <Card key={id} className="bg-white border border-gray-100 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-black tracking-wider text-gray-500">
                    {displayIdOf(id)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {booking.offeredToMe && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-700">
                        Offered to you
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
                        booking.deliverySpeed === "express"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-slate-100 text-slate-600"
                      }`}>
                      {booking.deliverySpeed === "express" ? "Express" : "Normal"}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="flex items-start gap-2 text-sm text-gray-800">
                    <MapPin size={14} className="text-emerald-600 mt-0.5 shrink-0" />
                    <span className="line-clamp-2">
                      {booking.pickupAddress?.fullAddress || "Pickup location"}
                    </span>
                  </p>
                  <p className="flex items-start gap-2 text-sm text-gray-500">
                    <Navigation size={14} className="text-rose-500 mt-0.5 shrink-0" />
                    <span className="line-clamp-2">
                      {booking.courierCompanyId?.name
                        ? `Drop at ${booking.courierCompanyId.name}`
                        : booking.dropAddress?.fullAddress || "Drop location"}
                    </span>
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-gray-600">
                  <span>{Number(booking.distanceToPickupKm || 0).toFixed(1)} km to pickup</span>
                  {isCod ? (
                    <span className="text-amber-700">Collect COD ₹{collect.toFixed(2)}</span>
                  ) : (
                    <span className="text-emerald-700">Prepaid</span>
                  )}
                  {booking.estimatedEarning > 0 && (
                    <span className="flex items-center text-emerald-700">
                      <IndianRupee size={12} />
                      {Number(booking.estimatedEarning).toFixed(2)} est.
                    </span>
                  )}
                </div>

                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canAccept || Boolean(acceptingId)}
                  onClick={() => handleAccept(booking)}
                  className="mt-3 w-full h-10 text-xs font-black uppercase tracking-wider">
                  {acceptingId === id
                    ? "Accepting..."
                    : willQueue
                      ? "Accept to waiting list"
                      : "Accept"}
                </Button>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
};

export default OpenBookings;
