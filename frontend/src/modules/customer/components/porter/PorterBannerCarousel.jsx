import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { customerPorterApi } from "../../services/customerPorterApi";
import { unwrapList } from "@core/api/unwrap";
import { cn } from "@/lib/utils";

/**
 * PorterBannerCarousel
 * 
 * Promotional and informational banner carousel for the Porter home screen.
 * Supports smooth auto-play, touch swipe, and indicator dots.
 */
export const PorterBannerCarousel = ({ service = "all", className = "" }) => {
  const [banners, setBanners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef(null);

  const fetchBanners = useCallback(async () => {
    try {
      setLoading(true);
      const res = await customerPorterApi.getActiveBanners(service);
      const raw = res?.data ?? res;
      const list =
        (Array.isArray(raw) && raw) ||
        (Array.isArray(raw?.results) && raw.results) ||
        (Array.isArray(raw?.result) && raw.result) ||
        (Array.isArray(raw?.data) && raw.data) ||
        unwrapList(res, "results") ||
        unwrapList(res) ||
        [];
      setBanners(list);
      setActiveIndex(0);
    } catch (err) {
      console.error("[PorterBannerCarousel] Failed to load banners:", err);
      setBanners([]);
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    fetchBanners();
  }, [fetchBanners]);

  const total = banners.length;

  // Auto-play timer
  useEffect(() => {
    if (total <= 1 || isPaused) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % total);
    }, 4500);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [total, isPaused]);

  const handleDragEnd = (_, info) => {
    const threshold = 40;
    if (info.offset.x < -threshold) {
      // Swipe left -> Next
      setActiveIndex((prev) => (prev + 1) % total);
    } else if (info.offset.x > threshold) {
      // Swipe right -> Prev
      setActiveIndex((prev) => (prev - 1 + total) % total);
    }
  };

  if (loading) {
    return (
      <div
        className={cn(
          "relative mt-4 aspect-[21/9] w-full animate-pulse rounded-[var(--sg-r-xl)] bg-sg-surface-2",
          className
        )}
      />
    );
  }

  if (total === 0) {
    return null;
  }

  return (
    <div
      className={cn("relative mt-4 overflow-hidden rounded-[var(--sg-r-xl)] shadow-[var(--sg-shadow)] select-none", className)}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={() => setIsPaused(true)}
      onTouchEnd={() => setIsPaused(false)}
    >
      <motion.div
        drag={total > 1 ? "x" : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.2}
        onDragEnd={handleDragEnd}
        animate={{ x: `-${(activeIndex / total) * 100}%` }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="flex"
        style={{ width: `${total * 100}%` }}
      >
        {banners.map((banner, index) => (
          <div
            key={banner._id || index}
            className="relative aspect-[21/9] w-full shrink-0 overflow-hidden bg-slate-900"
            style={{ width: `${100 / total}%` }}
          >
            <img
              src={banner.imageUrl}
              alt={banner.title || "Promotion banner"}
              className="h-full w-full object-cover pointer-events-none"
              loading={index === 0 ? "eager" : "lazy"}
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src =
                  "https://placehold.co/824x380/1e293b/ffffff?text=Courier+Special+Offer";
              }}
            />

            {/* Subtle Gradient & Content Overlay if title/subtitle present */}
            {(banner.title || banner.subtitle) && (
              <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent p-4 sm:p-5 flex flex-col justify-end pointer-events-none">
                {banner.title && (
                  <h3 className="font-bold text-white text-base sm:text-lg leading-snug line-clamp-1 drop-shadow-sm">
                    {banner.title}
                  </h3>
                )}
                {banner.subtitle && (
                  <p className="mt-0.5 text-xs sm:text-sm text-white/85 line-clamp-1 font-medium drop-shadow-sm">
                    {banner.subtitle}
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </motion.div>

      {/* Indicator Dots */}
      {total > 1 && (
        <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10 pointer-events-auto">
          {banners.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveIndex(i);
              }}
              aria-label={`Go to slide ${i + 1}`}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                i === activeIndex
                  ? "w-5 bg-white shadow-sm"
                  : "w-1.5 bg-white/40 hover:bg-white/70"
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default PorterBannerCarousel;
