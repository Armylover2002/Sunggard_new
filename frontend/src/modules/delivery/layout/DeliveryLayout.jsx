import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import { Toaster, toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { BellRing } from "lucide-react";
import { deliveryApi } from "../services/deliveryApi";
import { useAuth } from "@core/context/AuthContext";
import {
  getOrderSocket,
  onParcelAssigned,
  onParcelBroadcast,
  onParcelBroadcastWithdrawn,
} from "@/core/services/orderSocket";
import { parcelApi } from "../../customer/services/parcelApi";
import { saveDeliveryPartnerLocation } from "../utils/deliveryLastLocation";
import { createSocketTokenReader } from "@core/utils/authStorage";
import { STORAGE_KEYS } from "@core/utils/storage";
import orderAlertSound from "@/assets/sounds/order_alert.mp3";

const getDeliveryToken = createSocketTokenReader(STORAGE_KEYS.AUTH_DELIVERY);

/**
 * Match server parcel `searchExpiresAt`. The fallback below only fires when
 * an offer somehow arrives without one — it must track
 * PARCEL_SEQUENTIAL_OFFER_TIMEOUT_MS's own default (30s), not the old
 * simultaneous-broadcast window this UI was written for.
 */
function secondsLeftUntilParcelExpiry(expiresAt) {
  if (!expiresAt) return 30;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

const DeliveryLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const canReceiveOrders = Boolean(user?.isVerified) && user?.isOnline === true;
  const canReceiveParcelBroadcast =
    canReceiveOrders && Boolean(user?.isParcelService);

  const [activeParcel, setActiveParcel] = useState(null);
  const [activeParcelOffer, setActiveParcelOffer] = useState(null);
  const [parcelTimeLeft, setParcelTimeLeft] = useState(30);
  const [parcelAcceptWindowTotal, setParcelAcceptWindowTotal] = useState(30);
  const shownParcelIdsRef = useRef(new Set());
  const activeParcelRef = useRef(null);
  const activeParcelOfferRef = useRef(null);
  const riderOnJobRef = useRef(Boolean(user?.isBusy));
  const userBusyRef = useRef(Boolean(user?.isBusy));
  const canReceiveParcelBroadcastRef = useRef(canReceiveParcelBroadcast);
  const suppressIncomingModalRef = useRef(false);
  const availablePollLastAtRef = useRef(0);
  const notificationsRequestRef = useRef({ inFlight: false, controller: null });
  const locationRequestRef = useRef({ inFlight: false, controller: null });
  const orderRingtoneRef = useRef(null);
  const ringtoneRetryTimerRef = useRef(null);
  const ringtoneUnlockHandlerRef = useRef(null);

  useEffect(() => {
    riderOnJobRef.current = Boolean(user?.isBusy);
    userBusyRef.current = Boolean(user?.isBusy);
  }, [user?.isBusy]);

  useEffect(() => {
    canReceiveParcelBroadcastRef.current = canReceiveParcelBroadcast;
  }, [canReceiveParcelBroadcast]);

  useEffect(() => {
    activeParcelRef.current = activeParcel;
  }, [activeParcel]);

  useEffect(() => {
    activeParcelOfferRef.current = activeParcelOffer;
  }, [activeParcelOffer]);

  const [isAcceptingOrder, setIsAcceptingOrder] = useState(false);
  const acceptInFlightRef = useRef(false);

  const isRingtoneActiveRef = useRef(false);

  const getOrderRingtone = () => {
    if (!orderRingtoneRef.current) {
      const audio = new Audio(orderAlertSound);
      audio.loop = true;
      audio.preload = "auto";
      orderRingtoneRef.current = audio;
    }
    return orderRingtoneRef.current;
  };

  const startOrderRingtone = () => {
    isRingtoneActiveRef.current = true;
    const audio = getOrderRingtone();
    audio.loop = true;
    audio.preload = "auto";
    audio.muted = false;
    audio.volume = 1;
    audio.play().catch(() => {});

    if (!ringtoneRetryTimerRef.current) {
      ringtoneRetryTimerRef.current = setInterval(() => {
        if (!isRingtoneActiveRef.current) return;
        if (!activeParcelOfferRef.current) return;
        const currentAudio = getOrderRingtone();
        if (!currentAudio.paused) return;
        currentAudio.play().catch(() => {});
      }, 1200);
    }

    if (
      !ringtoneUnlockHandlerRef.current &&
      typeof window !== "undefined" &&
      typeof document !== "undefined"
    ) {
      const unlockPlayback = () => {
        if (!isRingtoneActiveRef.current) return;
        if (!activeParcelOfferRef.current) return;
        const currentAudio = getOrderRingtone();
        if (!currentAudio.paused) return;
        currentAudio.play().catch(() => {});
      };
      ringtoneUnlockHandlerRef.current = unlockPlayback;
      window.addEventListener("focus", unlockPlayback);
      document.addEventListener("visibilitychange", unlockPlayback);
      document.addEventListener("pointerdown", unlockPlayback);
      document.addEventListener("touchstart", unlockPlayback);
      document.addEventListener("keydown", unlockPlayback);
    }
  };

  const stopOrderRingtone = () => {
    isRingtoneActiveRef.current = false;
    const audio = orderRingtoneRef.current;
    if (ringtoneRetryTimerRef.current) {
      clearInterval(ringtoneRetryTimerRef.current);
      ringtoneRetryTimerRef.current = null;
    }
    if (
      ringtoneUnlockHandlerRef.current &&
      typeof window !== "undefined" &&
      typeof document !== "undefined"
    ) {
      window.removeEventListener("focus", ringtoneUnlockHandlerRef.current);
      document.removeEventListener(
        "visibilitychange",
        ringtoneUnlockHandlerRef.current,
      );
      document.removeEventListener(
        "pointerdown",
        ringtoneUnlockHandlerRef.current,
      );
      document.removeEventListener(
        "touchstart",
        ringtoneUnlockHandlerRef.current,
      );
      document.removeEventListener("keydown", ringtoneUnlockHandlerRef.current);
      ringtoneUnlockHandlerRef.current = null;
    }
    if (audio) {
      audio.loop = false;
      audio.pause();
      audio.currentTime = 0;
    }
  };

  /** While working an active parcel task, do not stack the global incoming-offer modal. */
  const suppressIncomingModal = useMemo(
    () => /\/delivery\/parcel-task/.test(location.pathname),
    [location.pathname],
  );

  useEffect(() => {
    suppressIncomingModalRef.current = suppressIncomingModal;
  }, [suppressIncomingModal]);

  const shouldBlockIncomingOffers = useCallback(() => {
    return (
      riderOnJobRef.current ||
      userBusyRef.current ||
      Boolean(activeParcelRef.current) ||
      Boolean(activeParcelOfferRef.current) ||
      suppressIncomingModalRef.current
    );
  }, []);

  /** Block incoming parcel offers if rider has any active job, open offer, or busy state. */
  const shouldBlockParcelOffers = useCallback(() => {
    return shouldBlockIncomingOffers();
  }, [shouldBlockIncomingOffers]);

  useEffect(() => {
    if (!canReceiveOrders) return undefined;
    refreshUser().catch(() => {});
  }, [canReceiveOrders, refreshUser]);

  useEffect(() => {
    if (user?.isVerified) return;
    acceptInFlightRef.current = false;
    setIsAcceptingOrder(false);
    stopOrderRingtone();
    setActiveParcel(null);
    setActiveParcelOffer(null);
  }, [user?.isVerified]);

  const applyFromParcelBroadcastPayload = useCallback(
    (payload) => {
      if (!payload?.parcelId) return false;
      if (shouldBlockIncomingOffers()) {
        return true;
      }
      if (shownParcelIdsRef.current.has(payload.parcelId)) return true;

      const p = payload.preview;
      if (!p || typeof p.pickup !== "string" || typeof p.drop !== "string") {
        return false;
      }

      const exp = payload.searchExpiresAt;
      if (exp && secondsLeftUntilParcelExpiry(exp) <= 0) {
        return false;
      }

      shownParcelIdsRef.current = new Set(shownParcelIdsRef.current).add(
        payload.parcelId,
      );
      const fare = typeof p.fare === "number" ? p.fare : Number(p.fare) || 0;
      const share =
        Math.min(100, Math.max(0, Number(p.riderSharePercent) ?? 80)) / 100;
      const earnings =
        typeof p.earnings === "number"
          ? p.earnings
          : Math.round(fare * share * 100) / 100;

      setActiveParcelOffer({
        parcelId: payload.parcelId,
        pickup: p.pickup,
        drop: p.drop,
        fare,
        earnings,
        riderSharePercent:
          Number(p.riderSharePercent) || Math.round(share * 100),
        weight: p.weight,
        distance: p.distance,
        deliverySpeed: p.deliverySpeed === "express" ? "express" : "normal",
        paymentMethod: String(p.paymentMethod || "").toUpperCase() || "COD",
        collectAmount: Number(p.collectAmount) || 0,
        parcelType: p.parcelType || "outstation",
        // Outstation earning is distance-based (accept point → pickup point),
        // so it can't be a real number until the rider actually accepts —
        // this is the rate the eventual amount will be computed from.
        riderPerKmRate: Number(p.riderPerKmRate) || 0,
        expiresAt: payload.searchExpiresAt || null,
        isBroadcast: true,
      });
      return true;
    },
    [shouldBlockIncomingOffers],
  );

  const applyAvailableParcelsList = useCallback(
    (availableParcels) => {
      if (shouldBlockIncomingOffers()) {
        return;
      }
      const nextParcel = availableParcels.find((parcel) => {
        const parcelId = parcel._id?.toString?.() || String(parcel._id);
        if (shownParcelIdsRef.current.has(parcelId)) return false;
        if (
          parcel.searchExpiresAt &&
          secondsLeftUntilParcelExpiry(parcel.searchExpiresAt) <= 0
        ) {
          return false;
        }
        return true;
      });
      if (!nextParcel) return;

      const parcelId = nextParcel._id?.toString?.() || String(nextParcel._id);
      shownParcelIdsRef.current = new Set(shownParcelIdsRef.current).add(
        parcelId,
      );
      const fare = Number(nextParcel.fare) || 0;
      const sharePercent = Math.min(
        100,
        Math.max(0, Number(nextParcel.riderSharePercent) ?? 80),
      );
      const share = sharePercent / 100;
      setActiveParcelOffer({
        parcelId,
        pickup: nextParcel.pickupAddress?.fullAddress || "Pickup location",
        drop: nextParcel.dropAddress?.fullAddress || "Drop location",
        fare,
        earnings:
          typeof nextParcel.earnings === "number"
            ? nextParcel.earnings
            : Math.round(fare * share * 100) / 100,
        riderSharePercent: sharePercent,
        weight: nextParcel.weight,
        distance: nextParcel.distance,
        deliverySpeed:
          nextParcel.deliverySpeed === "express" ? "express" : "normal",
        paymentMethod:
          String(nextParcel.paymentMethod || "").toUpperCase() || "COD",
        collectAmount:
          String(nextParcel.paymentMethod || "").toUpperCase() === "COD"
            ? Number(
                nextParcel.codSettlement?.collectAmount || nextParcel.fare,
              ) || 0
            : 0,
        expiresAt: nextParcel.searchExpiresAt || null,
        isBroadcast: true,
      });
    },
    [shouldBlockIncomingOffers],
  );

  useEffect(() => {
    if (activeParcelOffer) {
      startOrderRingtone();
    } else {
      stopOrderRingtone();
    }
    return () => {
      stopOrderRingtone();
    };
  }, [activeParcelOffer]);

  useEffect(() => {
    if (!activeParcelOffer) {
      stopOrderRingtone();
    }
  }, [location.pathname, activeParcelOffer]);

  const hideBottomNavRoutes = [
    "/delivery/login",
    "/delivery/auth",
    "/delivery/pending-approval",
    // CAR WASH DISABLED — "/delivery/car-wash-auth",
    "/delivery/splash",
    "/delivery/parcel-task",
  ];

  const shouldShowBottomNav = !hideBottomNavRoutes.some((route) =>
    location.pathname.includes(route),
  );

  const fetchNotifications = useCallback(async () => {
    if (notificationsRequestRef.current.inFlight) return null;
    notificationsRequestRef.current.inFlight = true;

    if (notificationsRequestRef.current.controller) {
      notificationsRequestRef.current.controller.abort();
    }
    const controller = new AbortController();
    notificationsRequestRef.current.controller = controller;

    try {
      return await deliveryApi.getNotifications({
        signal: controller.signal,
        timeout: 15000,
      });
    } catch (error) {
      if (
        error?.code === "ERR_CANCELED" ||
        error?.name === "CanceledError" ||
        error?.name === "AbortError"
      ) {
        return null;
      }
      throw error;
    } finally {
      if (notificationsRequestRef.current.controller === controller) {
        notificationsRequestRef.current.controller = null;
        notificationsRequestRef.current.inFlight = false;
      }
    }
  }, []);

  const postLocationOnce = useCallback(async (lat, lng) => {
    if (locationRequestRef.current.inFlight) return;
    locationRequestRef.current.inFlight = true;

    if (locationRequestRef.current.controller) {
      locationRequestRef.current.controller.abort();
    }
    const controller = new AbortController();
    locationRequestRef.current.controller = controller;

    try {
      saveDeliveryPartnerLocation(lat, lng);
      await deliveryApi.postLocation(
        { lat, lng },
        { signal: controller.signal, timeout: 10000 },
      );
    } catch {
      /* ignore */
    } finally {
      if (locationRequestRef.current.controller === controller) {
        locationRequestRef.current.controller = null;
        locationRequestRef.current.inFlight = false;
      }
    }
  }, []);

  // Available-parcels polling — safety net for missed socket broadcasts.
  //
  // Socket (`onParcelBroadcast`) remains the primary channel. This effect
  // adds a low-frequency fallback so a rider who came online *after* the
  // broadcast left the wire, or whose socket dropped without reconnecting,
  // will still see new jobs within ~30s.
  //
  // Guards: only ticks while the rider is online and eligible for parcel
  // jobs, the foreground tab is visible, no active-offer modal is up, and
  // the route isn't already in an active parcel-task flow. Effect deps are
  // intentionally minimal — blockers live in refs so user/busy/path changes
  // do not restart the timer and re-hit the API.
  useEffect(() => {
    if (!canReceiveParcelBroadcast) return undefined;

    let cancelled = false;
    let timer = null;
    let consecutiveErrors = 0;

    const BASE_DELAY_MS = 30000;
    const MAX_DELAY_MS = 90000;
    const MIN_GAP_MS = 20000;

    const tick = async ({ force = false } = {}) => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }

      const now = Date.now();
      if (!force && now - availablePollLastAtRef.current < MIN_GAP_MS) {
        return;
      }
      availablePollLastAtRef.current = now;

      try {
        if (
          canReceiveParcelBroadcastRef.current &&
          !shouldBlockParcelOffers()
        ) {
          const parcelRes = await parcelApi.riderGetAvailable({ ttl: 20000 });
          if (!cancelled && parcelRes?.data?.success) {
            const parcelList =
              parcelRes.data.results || parcelRes.data.result || [];
            applyAvailableParcelsList(parcelList);
          }
        }

        consecutiveErrors = 0;
      } catch (error) {
        if (
          error?.code === "ERR_CANCELED" ||
          error?.name === "CanceledError" ||
          error?.name === "AbortError"
        ) {
          return;
        }
        consecutiveErrors += 1;
        console.error("Delivery Polling Error:", error);
      }
    };

    const computeDelay = () => {
      if (!consecutiveErrors) return BASE_DELAY_MS;
      return Math.min(
        MAX_DELAY_MS,
        BASE_DELAY_MS * 2 ** (consecutiveErrors - 1),
      );
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        await tick();
        schedule();
      }, computeDelay());
    };

    // Kick off immediately, then schedule the recurring tick.
    tick({ force: true });
    schedule();

    // Wake-up: if the rider tabs back / focuses the window, fetch once
    // (still respects MIN_GAP so rapid focus spam does not hammer APIs).
    const wakeUp = () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      tick();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", wakeUp);
      document.addEventListener("visibilitychange", wakeUp);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", wakeUp);
        document.removeEventListener("visibilitychange", wakeUp);
      }
    };
  }, [
    canReceiveParcelBroadcast,
    applyAvailableParcelsList,
    shouldBlockParcelOffers,
  ]);

  // Background location heartbeat while the rider is online.
  //
  // Seller service-radius matching depends on the latest rider coords on
  // the server. A one-shot `getCurrentPosition` at go-online time goes
  // stale the moment the rider moves, so we run a `watchPosition` here
  // and post a heartbeat at most once every 30s. (The richer/faster
  // ~5s `watchPosition` inside `ParcelTaskPage` stays as-is for active
  // parcel jobs; both can coexist — each has its own POST throttle
  // and the backend further throttles via `shouldThrottle`.)
  //
  // Guards:
  //   - online required (cleanup aborts in-flight POST when toggled off)
  //   - tab hidden → keep updating the local cache so the next route
  //     fetch / map mount uses fresh coords, but skip the network POST
  //     to save battery; resumes on next visible fix.
  useEffect(() => {
    if (
      !canReceiveOrders ||
      typeof navigator === "undefined" ||
      !navigator.geolocation
    ) {
      if (locationRequestRef.current.controller) {
        locationRequestRef.current.controller.abort();
      }
      return undefined;
    }

    const HEARTBEAT_MS = 30000;
    let lastPostAt = 0;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        // Always refresh the local cache so the map / route fetch always
        // has the freshest coords when they mount.
        saveDeliveryPartnerLocation(lat, lng);

        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          return;
        }

        const now = Date.now();
        if (now - lastPostAt < HEARTBEAT_MS) return;
        lastPostAt = now;
        postLocationOnce(lat, lng);
      },
      () => {
        /* permission denied / position unavailable — silently ignore;
           the rider just won't receive proximity matches until they
           grant location or move into a covered area. */
      },
      { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 },
    );

    return () => {
      if (watchId !== null && navigator.geolocation?.clearWatch) {
        navigator.geolocation.clearWatch(watchId);
      }
      if (locationRequestRef.current.controller) {
        locationRequestRef.current.controller.abort();
      }
    };
  }, [canReceiveOrders, postLocationOnce]);

  useEffect(() => {
    if (!canReceiveOrders) return undefined;
    getOrderSocket(getDeliveryToken);
  }, [canReceiveOrders]);

  useEffect(() => {
    if (!canReceiveParcelBroadcast) return undefined;
    const getToken = getDeliveryToken;
    return onParcelBroadcast(getToken, (payload) => {
      if (shouldBlockParcelOffers()) return;
      const opened = applyFromParcelBroadcastPayload(payload);
      if (opened) return;
      parcelApi
        .riderGetAvailable()
        .then((res) => {
          if (!res?.data?.success) return;
          const list = res.data.results || res.data.result || [];
          applyAvailableParcelsList(list);
        })
        .catch(() => {});
    });
  }, [
    canReceiveParcelBroadcast,
    applyFromParcelBroadcastPayload,
    applyAvailableParcelsList,
    shouldBlockParcelOffers,
  ]);

  useEffect(() => {
    if (!canReceiveParcelBroadcast) return undefined;
    const getToken = getDeliveryToken;
    return onParcelBroadcastWithdrawn(getToken, (payload) => {
      const parcelId = payload?.parcelId;
      if (!parcelId) return;

      shownParcelIdsRef.current = new Set(shownParcelIdsRef.current).add(
        parcelId,
      );

      if (activeParcelOfferRef.current?.parcelId === parcelId) {
        acceptInFlightRef.current = false;
        setIsAcceptingOrder(false);
        stopOrderRingtone();
        setActiveParcelOffer(null);
        toast.info("Another rider accepted this parcel.");
      }
    });
  }, [canReceiveParcelBroadcast, shouldBlockIncomingOffers]);

  useEffect(() => {
    if (!canReceiveParcelBroadcast) return undefined;
    const getToken = getDeliveryToken;
    return onParcelAssigned(getToken, (parcel) => {
      const parcelId = parcel._id?.toString?.() || String(parcel._id);
      if (shownParcelIdsRef.current.has(parcelId)) return;
      setActiveParcel(null);
      setActiveParcelOffer(null);
      stopOrderRingtone();
      toast.success("Parcel assigned. Continue with pickup workflow.");
      navigate(`/delivery/parcel-task/${parcelId}`);
    });
  }, [canReceiveParcelBroadcast, navigate]);

  // Notifications safety-net polling.
  //
  // Same idea as the available-parcels poll above but slower (~25s) since
  // this is the third line of defense: socket → available-parcels poll →
  // notifications inbox. If both real-time channels miss a broadcast, the
  // unread notification row eventually surfaces the offer here.
  useEffect(() => {
    if (!canReceiveOrders) {
      if (notificationsRequestRef.current.controller) {
        notificationsRequestRef.current.controller.abort();
      }
      return undefined;
    }

    let cancelled = false;
    let timer = null;
    let consecutiveErrors = 0;

    const BASE_DELAY_MS = 25000;
    const MAX_DELAY_MS = 90000;

    const tick = async () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }

      try {
        const res = await fetchNotifications();
        if (cancelled || !res?.data?.success) return;
        const result = res.data.result || res.data.data;
        const notifications = result?.notifications || [];
        for (const n of notifications) {
          if (n.type === "parcel" && !n.isRead && n.data?.parcelId) {
            if (shouldBlockParcelOffers()) continue;
            const parcelId = n.data.parcelId;
            if (shownParcelIdsRef.current.has(parcelId)) continue;
            const fromParcel = applyFromParcelBroadcastPayload({
              parcelId,
              preview: n.data.preview,
              searchExpiresAt: n.data.searchExpiresAt,
            });
            if (fromParcel) return;
          }
        }

        consecutiveErrors = 0;
      } catch (error) {
        if (
          error?.code === "ERR_CANCELED" ||
          error?.name === "CanceledError" ||
          error?.name === "AbortError"
        ) {
          return;
        }
        consecutiveErrors += 1;
        /* swallow noisy errors; backoff already throttles retries */
      }
    };

    const computeDelay = () => {
      if (!consecutiveErrors) return BASE_DELAY_MS;
      return Math.min(
        MAX_DELAY_MS,
        BASE_DELAY_MS * 2 ** (consecutiveErrors - 1),
      );
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        await tick();
        schedule();
      }, computeDelay());
    };

    tick();
    schedule();

    const wakeUp = () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      tick();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", wakeUp);
      document.addEventListener("visibilitychange", wakeUp);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", wakeUp);
        document.removeEventListener("visibilitychange", wakeUp);
      }
      if (notificationsRequestRef.current.controller) {
        notificationsRequestRef.current.controller.abort();
      }
    };
  }, [
    canReceiveOrders,
    applyFromParcelBroadcastPayload,
    shouldBlockParcelOffers,
    fetchNotifications,
  ]);

  const skipParcelOffer = useCallback(async () => {
    const current = activeParcelOfferRef.current;
    if (!current || acceptInFlightRef.current) return;
    stopOrderRingtone();
    activeParcelOfferRef.current = null;
    setActiveParcelOffer(null);
    try {
      await parcelApi.riderRejectParcel(current.parcelId);
      shownParcelIdsRef.current = new Set(shownParcelIdsRef.current).add(
        current.parcelId,
      );
      stopOrderRingtone();
      await refreshUser().catch(() => {});
      toast.info("Parcel offer skipped");
    } catch (error) {
      console.error("Parcel offer skip failed:", error);
      stopOrderRingtone();
      await refreshUser().catch(() => {});
    }
  }, [refreshUser]);

  useEffect(() => {
    if (!activeParcelOffer) return undefined;
    const left = secondsLeftUntilParcelExpiry(activeParcelOffer.expiresAt);
    if (left <= 0) {
      if (!acceptInFlightRef.current) {
        skipParcelOffer();
        toast.error("Parcel request timed out");
      }
      return undefined;
    }
    setParcelAcceptWindowTotal(left);
    setParcelTimeLeft(left);
    const timer = setInterval(() => {
      const next = secondsLeftUntilParcelExpiry(
        activeParcelOfferRef.current?.expiresAt,
      );
      setParcelTimeLeft(next);
      if (next <= 0) {
        clearInterval(timer);
        if (!acceptInFlightRef.current) {
          skipParcelOffer();
          toast.error("Parcel request timed out");
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activeParcelOffer, skipParcelOffer]);

  const handleAcceptParcelOffer = async () => {
    const offer = activeParcelOfferRef.current;
    if (!offer || acceptInFlightRef.current) return;
    if (offer.expiresAt && secondsLeftUntilParcelExpiry(offer.expiresAt) <= 0) {
      toast.error("This parcel request has expired.");
      stopOrderRingtone();
      setActiveParcelOffer(null);
      return;
    }

    const parcelId = offer.parcelId;

    // Stop ringtone and clear offer state immediately on tap
    stopOrderRingtone();
    activeParcelOfferRef.current = null;
    setActiveParcelOffer(null);

    acceptInFlightRef.current = true;
    setIsAcceptingOrder(true);
    try {
      const idem =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}`;
      await parcelApi.riderAcceptParcel(parcelId, idem);
      shownParcelIdsRef.current = new Set(shownParcelIdsRef.current).add(
        parcelId,
      );
      riderOnJobRef.current = true;
      await refreshUser();
      stopOrderRingtone();
      navigate(`/delivery/parcel-task/${parcelId}`);
    } catch (error) {
      const msg =
        error.response?.data?.message ||
        (typeof error.response?.data === "string" ? error.response.data : null);
      toast.error(msg || "Failed to accept parcel");
      stopOrderRingtone();
    } finally {
      acceptInFlightRef.current = false;
      setIsAcceptingOrder(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans max-w-md mx-auto relative shadow-2xl overflow-hidden border-x border-border">
      {/* Full-screen parcel alert — portaled so it always stacks above nav/content */}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {activeParcelOffer && (
              <div
                className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/85 backdrop-blur-sm max-w-md mx-auto"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delivery-parcel-offer-title">
                <motion.div
                  key={activeParcelOffer.parcelId}
                  initial={{ scale: 0.92, opacity: 0, y: 24 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.96, opacity: 0, y: 16 }}
                  transition={{ type: "spring", stiffness: 380, damping: 28 }}
                  className="bg-white rounded-[32px] p-6 w-full max-w-[340px] shadow-2xl border-4 border-primary/20">
                  <div className="flex flex-col items-center">
                    <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 animate-bounce">
                      <BellRing className="h-8 w-8 text-primary" />
                    </div>

                    <h2
                      id="delivery-parcel-offer-title"
                      className="text-xl font-black text-slate-900 mb-1">
                      New parcel request
                      Outstation Parcel Request
                    </h2>
                    {activeParcelOffer.deliverySpeed === "express" ? (
                      <span className="mb-3 inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
                        Express · 10 min
                      </span>
                    ) : (
                      <span className="mb-3 inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">
                        Normal · 30 min
                      </span>
                    )}
                    <div className="flex flex-wrap items-center justify-center gap-1.5 mb-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
                        📦 Drop at Courier
                      </span>
                      {activeParcelOffer.deliverySpeed === "express" ? (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
                          Express · 10 min
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">
                          Normal · 30 min
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-4">
                      First to accept gets the delivery
                    </p>

                    {activeParcelOffer.parcelType === "local" ? (
                      <div className="flex items-center gap-2 mb-6">
                        <span className="text-2xl font-black text-brand-600">
                          ₹{activeParcelOffer.earnings}
                        </span>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                          You&apos;ll get
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-0.5 mb-6">
                        <div className="flex items-center gap-2">
                          <span className="text-2xl font-black text-brand-600">
                            ₹{activeParcelOffer.riderPerKmRate}/km
                          </span>
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                            Your rate
                          </span>
                        </div>
                        <p className="text-[10px] font-semibold text-slate-400">
                          Final amount = this rate × your distance to pickup,
                          shown once you accept
                        </p>
                      </div>
                    )}

                    {String(activeParcelOffer.paymentMethod).toUpperCase() ===
                      "COD" &&
                      Number(activeParcelOffer.collectAmount) > 0 && (
                        <div className="w-full mb-4 rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-center">
                          <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
                            Collect from customer (COD)
                          </p>
                          <p className="text-2xl font-black text-amber-900 mt-0.5">
                            ₹
                            {Number(activeParcelOffer.collectAmount).toFixed(2)}
                          </p>
                          <p className="text-[10px] font-semibold text-amber-700/80 mt-1">
                            Hand this cash at the courier company
                          </p>
                        </div>
                      )}

                    <div className="w-full bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3 mb-6 text-left text-xs">
                      <div>
                        <strong className="text-slate-800 block mb-0.5">
                          Pickup:
                        </strong>
                        <p className="text-slate-500 font-medium line-clamp-2">
                          {activeParcelOffer.pickup}
                        </p>
                      </div>
                      <div className="border-t border-slate-200/60 pt-2.5">
                        <strong className="text-slate-800 block mb-0.5">
                          Dropoff (Courier):
                        </strong>
                        <p className="text-slate-500 font-medium line-clamp-2">
                          {activeParcelOffer.drop}
                        </p>
                      </div>
                      {activeParcelOffer.weight != null && (
                        <div className="border-t border-slate-200/60 pt-2.5">
                          <span className="text-slate-600 font-bold">
                            {activeParcelOffer.weight} KG
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="w-full h-1.5 bg-slate-100 rounded-full mb-2 overflow-hidden">
                      <motion.div
                        key={`${activeParcelOffer.parcelId}-${parcelAcceptWindowTotal}`}
                        initial={{ width: "100%" }}
                        animate={{ width: "0%" }}
                        transition={{
                          duration: Math.max(1, parcelAcceptWindowTotal || 30),
                          ease: "linear",
                        }}
                        className={
                          parcelTimeLeft < 10
                            ? "bg-rose-500 h-full"
                            : "bg-primary h-full"
                        }
                      />
                    </div>
                    <p className="text-[10px] font-bold text-slate-400 mb-4 w-full text-center">
                      {parcelTimeLeft}s left to respond
                    </p>

                    <div className="grid grid-cols-2 gap-3 w-full">
                      <button
                        type="button"
                        disabled={isAcceptingOrder}
                        onClick={skipParcelOffer}
                        className="py-4 rounded-2xl bg-slate-100 text-slate-700 font-black text-xs uppercase tracking-wider hover:bg-slate-200/80 disabled:opacity-50">
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={isAcceptingOrder}
                        onClick={handleAcceptParcelOffer}
                        className="py-4 rounded-2xl bg-primary text-primary-foreground font-black text-xs uppercase tracking-wider shadow-lg shadow-primary/30 active:scale-95 disabled:opacity-60">
                        {isAcceptingOrder ? "Accepting…" : "Accept"}
                      </button>
                    </div>
                  </div>
                </motion.div>
              </div>
            )}

            {activeParcel && (
              <div
                className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/85 backdrop-blur-sm max-w-md mx-auto"
                role="dialog"
                aria-modal="true"
                aria-labelledby="delivery-parcel-alert-title">
                <motion.div
                  key={activeParcel._id}
                  initial={{ scale: 0.92, opacity: 0, y: 24 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.96, opacity: 0, y: 16 }}
                  transition={{ type: "spring", stiffness: 380, damping: 28 }}
                  className="bg-white rounded-[32px] p-6 w-full max-w-[340px] shadow-2xl border-4 border-primary/20">
                  <div className="flex flex-col items-center">
                    <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center mb-4 animate-bounce">
                      <BellRing className="h-8 w-8 text-primary" />
                    </div>

                    <h2
                      id="delivery-parcel-alert-title"
                      className="text-xl font-black text-slate-900 mb-1">
                      New Parcel Assigned!
                    </h2>
                    {activeParcel.deliverySpeed === "express" ? (
                      <span className="mb-2 inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
                        Express · 10 min
                      </span>
                    ) : (
                      <span className="mb-2 inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">
                        Normal · 30 min
                      </span>
                    )}

                    <p className="text-xs text-slate-500 font-bold mb-4">
                      ID: #{activeParcel._id.slice(-6)}
                    </p>

                    {String(activeParcel.paymentMethod).toUpperCase() ===
                      "COD" && (
                      <div className="w-full mb-4 rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-center">
                        <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
                          Collect from customer (COD)
                        </p>
                        <p className="text-2xl font-black text-amber-900 mt-0.5">
                          ₹
                          {Number(
                            activeParcel.codSettlement?.collectAmount ||
                              activeParcel.fare ||
                              0,
                          ).toFixed(2)}
                        </p>
                        <p className="text-[10px] font-semibold text-amber-700/80 mt-1">
                          Give full cash to seller after delivery
                        </p>
                      </div>
                    )}

                    <div className="w-full bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3 mb-6 text-left text-xs">
                      <div>
                        <strong className="text-slate-800 block mb-0.5">
                          Pickup Address:
                        </strong>
                        <p className="text-slate-600 font-medium">
                          {activeParcel.pickupAddress.name} (
                          {activeParcel.pickupAddress.phone})
                        </p>
                        <p className="text-slate-400 font-medium mt-0.5 truncate">
                          {activeParcel.pickupAddress.fullAddress}
                        </p>
                      </div>
                      <div className="border-t border-slate-200/60 pt-2.5">
                        <strong className="text-slate-800 block mb-0.5">
                          Dropoff Address:
                        </strong>
                        <p className="text-slate-600 font-medium">
                          {activeParcel.dropAddress.name} (
                          {activeParcel.dropAddress.phone})
                        </p>
                        <p className="text-slate-400 font-medium mt-0.5 truncate">
                          {activeParcel.dropAddress.fullAddress}
                        </p>
                      </div>
                      <div className="border-t border-slate-200/60 pt-2.5 flex justify-between items-center">
                        <div>
                          <strong className="text-slate-800 block mb-0.5">
                            You&apos;ll get:
                          </strong>
                          <span className="text-brand-600 font-black text-sm">
                            ₹
                            {Number(
                              activeParcel.earnings != null
                                ? activeParcel.earnings
                                : Math.round(
                                    (Number(activeParcel.fare) || 0) *
                                      (Math.min(
                                        100,
                                        Math.max(
                                          0,
                                          Number(
                                            activeParcel.riderSharePercent,
                                          ) ?? 80,
                                        ),
                                      ) /
                                        100) *
                                      100,
                                  ) / 100,
                            ).toFixed(2)}
                          </span>
                        </div>
                        <div className="text-right">
                          <strong className="text-slate-800 block mb-0.5">
                            Weight:
                          </strong>
                          <span className="text-slate-600 font-bold">
                            {activeParcel.weight} KG
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 w-full">
                      <button
                        type="button"
                        disabled={isAcceptingOrder}
                        className="py-4 rounded-2xl bg-primary text-primary-foreground font-black text-xs uppercase tracking-wider shadow-lg shadow-primary/30 active:scale-95 disabled:opacity-60 disabled:pointer-events-none"
                        onClick={async () => {
                          try {
                            setIsAcceptingOrder(true);
                            const res = await parcelApi.riderUpdateStatus({
                              parcelId: activeParcel._id,
                              status: "ACCEPTED",
                            });
                            if (res.data?.success) {
                              toast.success("Parcel task accepted!");
                              navigate(
                                `/delivery/parcel-task/${activeParcel._id}`,
                              );
                            }
                          } catch (err) {
                            // Already assigned: open task directly (cancel after accept is not allowed).
                            toast.success("Opening assigned parcel task");
                            navigate(
                              `/delivery/parcel-task/${activeParcel._id}`,
                            );
                          } finally {
                            setIsAcceptingOrder(false);
                            setActiveParcel(null);
                            stopOrderRingtone();
                          }
                        }}>
                        Continue Task
                      </button>
                    </div>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}

      <main
        className={`h-full min-h-screen overflow-y-auto ${shouldShowBottomNav ? "pb-24" : ""} no-scrollbar`}>
        <Outlet />
      </main>

      {shouldShowBottomNav && <BottomNav />}
      <Toaster position="top-center" />
    </div>
  );
};

export default DeliveryLayout;
