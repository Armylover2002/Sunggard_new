import React, { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { parcelApi } from "../../services/parcelApi";

/**
 * Rating + review form shown after a parcel is DELIVERED.
 * @param {boolean} compact — tighter layout for history list cards
 */
export default function ParcelReviewPrompt({ parcelId, onSubmitted, compact = false }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(!compact);

  useEffect(() => {
    let cancelled = false;
    if (!parcelId) return undefined;

    (async () => {
      try {
        setLoading(true);
        const res = await parcelApi.getMyReview(parcelId);
        if (cancelled) return;
        const review = res.data?.result || null;
        setExisting(review);
        if (review) {
          setRating(Number(review.rating) || 0);
          setComment(review.comment || "");
        }
      } catch {
        if (!cancelled) setExisting(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [parcelId]);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (rating < 1) {
      toast.error("Please select a star rating");
      return;
    }
    try {
      setSubmitting(true);
      const res = await parcelApi.submitReview({
        parcelId,
        rating,
        comment: comment.trim(),
      });
      if (res.data?.success) {
        toast.success(res.data.message || "Thanks for your feedback!");
        const saved = res.data.result || {
          rating,
          comment: comment.trim(),
          status: "approved",
        };
        setExisting(saved);
        onSubmitted?.(saved);
      } else {
        toast.error(res.data?.message || "Could not submit review");
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not submit review");
    } finally {
      setSubmitting(false);
    }
  };

  if (!parcelId || loading) return null;

  if (existing) {
    return (
      <div
        className={
          compact
            ? "rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2.5"
            : "rounded-2xl border border-emerald-100 bg-emerald-50 p-4"
        }
      >
        <p className="text-[10px] font-black uppercase tracking-wider text-emerald-700 mb-1.5">
          Your rating
        </p>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              size={compact ? 14 : 18}
              className={
                n <= Number(existing.rating)
                  ? "fill-amber-400 text-amber-400"
                  : "text-slate-300"
              }
            />
          ))}
          <span className="text-xs font-bold text-slate-800 ml-1.5">
            {Number(existing.rating).toFixed(0)}/5
          </span>
        </div>
        {existing.comment ? (
          <p className={`text-slate-600 font-medium leading-relaxed ${compact ? "text-xs mt-1 line-clamp-2" : "text-sm mt-2"}`}>
            “{existing.comment}”
          </p>
        ) : !compact ? (
          <p className="text-xs text-slate-500 mt-1">Thanks for rating our courier service.</p>
        ) : null}
      </div>
    );
  }

  if (compact && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-amber-100/80 transition-colors"
      >
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
            Rate your experience
          </p>
          <p className="text-xs font-bold text-slate-800 mt-0.5 truncate">
            Tap to rate this delivery
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star key={n} size={14} className="text-amber-300" />
          ))}
        </div>
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={
        compact
          ? "rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2.5"
          : "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3"
      }
    >
      <div>
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
          Rate your experience
        </p>
        <p className={`font-bold text-slate-800 mt-0.5 ${compact ? "text-xs" : "text-sm"}`}>
          How was your courier experience?
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const active = n <= (hover || rating);
          return (
            <button
              key={n}
              type="button"
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n)}
              className="p-0.5 transition-transform active:scale-90"
              aria-label={`${n} star`}
            >
              <Star
                size={compact ? 22 : 28}
                className={
                  active
                    ? "fill-amber-400 text-amber-400"
                    : "text-slate-300"
                }
              />
            </button>
          );
        })}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, 500))}
        rows={compact ? 2 : 3}
        placeholder="Write a short review (optional)"
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary resize-none bg-white"
      />

      <button
        type="submit"
        disabled={submitting || rating < 1}
        className="w-full py-2.5 rounded-xl bg-primary text-white font-black text-xs uppercase tracking-wider disabled:opacity-60"
      >
        {submitting ? "Submitting..." : "Submit review"}
      </button>
    </form>
  );
}
