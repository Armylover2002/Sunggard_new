import React, { useEffect, useMemo, useState } from "react";
import { Star, MessageSquareQuote, ChevronDown, X } from "lucide-react";
import { parcelApi } from "../../services/parcelApi";

const PREVIEW_LIMIT = 3;

function ReviewCard({ review }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <div className="flex items-center gap-1 mb-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            size={14}
            className={
              n <= Number(review.rating)
                ? "fill-amber-400 text-amber-400"
                : "text-slate-300"
            }
          />
        ))}
      </div>
      <p className="text-sm text-slate-700 font-medium leading-relaxed">
        {review.comment ? `“${review.comment}”` : "Rated the courier service."}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-800 truncate">
          {review.customerName || "Customer"}
        </p>
        <p className="text-[10px] text-slate-400 font-semibold shrink-0">
          {review.createdAt
            ? new Date(review.createdAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })
            : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * Accordion ratings & reviews under Pickup Point.
 * Shows latest 3 reviews; "See all" opens a modal with the full list.
 */
export default function ParcelReviewsSection() {
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [seeAllOpen, setSeeAllOpen] = useState(false);
  const [avgRating, setAvgRating] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await parcelApi.getReviews({ limit: 50 });
        if (cancelled) return;
        const result = res.data?.result || {};
        setItems(Array.isArray(result.items) ? result.items : []);
        setAvgRating(Number(result.avgRating) || 0);
        setReviewCount(Number(result.reviewCount) || 0);
      } catch {
        if (!cancelled) {
          setItems([]);
          setAvgRating(0);
          setReviewCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const previewItems = useMemo(() => items.slice(0, PREVIEW_LIMIT), [items]);
  const hasMore = items.length > PREVIEW_LIMIT || reviewCount > PREVIEW_LIMIT;

  if (loading) {
    return (
      <div className="bg-white rounded-3xl p-5 border border-slate-100 shadow-sm">
        <p className="text-sm text-slate-400 font-medium">Loading reviews…</p>
      </div>
    );
  }

  if (!items.length) return null;

  return (
    <>
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full px-5 py-4 flex items-start justify-between gap-3 text-left hover:bg-slate-50/80 transition-colors"
          aria-expanded={open}
        >
          <div className="min-w-0">
            <h2 className="text-lg font-black text-slate-800 flex items-center gap-2">
              <MessageSquareQuote className="text-primary shrink-0" size={20} />
              Ratings & reviews
            </h2>
            <p className="text-xs text-slate-500 font-medium mt-1">
              What other users say about our courier service
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="flex items-center gap-1 justify-end">
                <Star size={16} className="fill-amber-400 text-amber-400" />
                <span className="text-lg font-black text-slate-900">
                  {avgRating.toFixed(1)}
                </span>
              </div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {reviewCount} review{reviewCount === 1 ? "" : "s"}
              </p>
            </div>
            <ChevronDown
              size={20}
              className={`text-slate-400 transition-transform duration-200 ${
                open ? "rotate-180" : ""
              }`}
            />
          </div>
        </button>

        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-out ${
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div className="px-5 pb-5 space-y-3 border-t border-slate-100 pt-4">
              {previewItems.map((review) => (
                <ReviewCard key={review._id} review={review} />
              ))}

              {hasMore && (
                <button
                  type="button"
                  onClick={() => setSeeAllOpen(true)}
                  className="w-full py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-primary text-sm font-black transition-colors"
                >
                  See all reviews
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {seeAllOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-slate-900/45 p-0 sm:p-4"
          onClick={() => setSeeAllOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-lg max-h-[85vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="All courier reviews"
          >
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 shrink-0">
              <div>
                <h3 className="text-lg font-black text-slate-900">All reviews</h3>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  {avgRating.toFixed(1)} avg · {reviewCount} review
                  {reviewCount === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSeeAllOpen(false)}
                className="h-9 w-9 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-200"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-3">
              {items.map((review) => (
                <ReviewCard key={review._id} review={review} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
