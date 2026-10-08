import React, { useEffect, useState } from "react";
import { Star, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import Modal from "@shared/components/ui/Modal";
import { cn } from "@/lib/utils";
import {
  POSITIVE_RIDER_TAGS,
  NEGATIVE_RIDER_TAGS,
  RIDER_STAR_WORDS,
  riderTagLabel,
} from "@shared/constants/riderRating";
import { parcelApi } from "../../services/parcelApi";

/**
 * "How was your rider?" — shown once a courier is delivered.
 *
 * Rates the PERSON who delivered. The older inline card on the tracking page
 * rates the service and is separate on purpose.
 *
 * "Maybe later" snoozes the popup for a day for that booking rather than
 * dismissing it for good, so someone who closes it in a hurry is asked once
 * more — but is never nagged on every screen.
 */

const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (parcelId) => `rider-rating-snoozed:${parcelId}`;

export function isRiderRatingSnoozed(parcelId) {
  try {
    const until = Number(localStorage.getItem(snoozeKey(parcelId)) || 0);
    return until > Date.now();
  } catch {
    return false;
  }
}

function snoozeRiderRating(parcelId) {
  try {
    localStorage.setItem(snoozeKey(parcelId), String(Date.now() + SNOOZE_MS));
  } catch {
    /* private mode — the popup simply may reappear */
  }
}

const Avatar = ({ rider }) =>
  rider?.profileImage ? (
    <img
      src={rider.profileImage}
      alt=""
      className="h-16 w-16 rounded-full object-cover border-2 border-white shadow"
    />
  ) : (
    <div className="h-16 w-16 rounded-full bg-slate-900 text-white flex items-center justify-center text-2xl font-black shadow">
      {String(rider?.name || "R").charAt(0).toUpperCase()}
    </div>
  );

export default function RiderRatingPopup({ parcelId, open, onClose, onRated }) {
  const [loading, setLoading] = useState(true);
  const [rider, setRider] = useState(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [tags, setTags] = useState([]);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Look the booking up when the popup opens: rate only if it is eligible and
  // not already rated (e.g. from another device).
  useEffect(() => {
    if (!open || !parcelId) return undefined;
    let cancelled = false;

    setLoading(true);
    setDone(false);
    setRating(0);
    setHover(0);
    setTags([]);
    setComment("");

    (async () => {
      try {
        const res = await parcelApi.getRiderRating(parcelId);
        if (cancelled) return;
        const data = res.data?.result;
        if (!data?.eligible || data.rated || !data.rider) {
          onClose?.();
          return;
        }
        setRider(data.rider);
      } catch {
        if (!cancelled) onClose?.();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parcelId]);

  const shown = hover || rating;
  const tagChoices = rating >= 4 ? POSITIVE_RIDER_TAGS : rating >= 1 ? NEGATIVE_RIDER_TAGS : [];

  const toggleTag = (tag) =>
    setTags((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag].slice(0, 5),
    );

  const pickRating = (value) => {
    setRating(value);
    // A tag from the other side no longer fits the rating.
    setTags((current) =>
      current.filter((t) => (value >= 4 ? POSITIVE_RIDER_TAGS : NEGATIVE_RIDER_TAGS).includes(t)),
    );
  };

  const handleSubmit = async () => {
    if (rating < 1 || submitting) return;
    setSubmitting(true);
    try {
      const res = await parcelApi.submitRiderRating({
        parcelId,
        rating,
        tags,
        comment: comment.trim(),
      });
      if (res.data?.success) {
        setDone(true);
        onRated?.({ rating, tags, comment: comment.trim() });
        setTimeout(() => onClose?.(), 1600);
      } else {
        toast.error(res.data?.message || "Could not submit your rating");
      }
    } catch (error) {
      const message = error?.response?.data?.message || "Could not submit your rating";
      toast.error(message);
      // Already rated elsewhere — nothing more to ask.
      if (error?.response?.status === 400 && /already/i.test(message)) onClose?.();
    } finally {
      setSubmitting(false);
    }
  };

  const handleLater = () => {
    snoozeRiderRating(parcelId);
    onClose?.();
  };

  if (!open) return null;

  return (
    <Modal isOpen={open} onClose={handleLater} title="Rate your rider" size="sm">
      <div className="px-6 pb-6 pt-4">
        {loading ? (
          <div className="py-10 text-center text-sm font-semibold text-slate-400">Loading…</div>
        ) : done ? (
          <div className="py-8 flex flex-col items-center text-center">
            <CheckCircle2 size={44} className="text-emerald-500" />
            <p className="mt-3 text-lg font-bold text-slate-900">Thanks for your feedback!</p>
            <p className="mt-1 text-sm text-slate-500">It helps us keep deliveries great.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <Avatar rider={rider} />
              <p className="mt-3 text-base font-bold text-slate-900">
                How was {rider?.name || "your rider"}?
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Your courier was delivered. Tell us about the delivery.
              </p>
              {rider?.ratingCount > 0 && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                  <Star size={12} className="fill-amber-400 text-amber-400" />
                  {Number(rider.rating).toFixed(1)} · {rider.ratingCount} rating
                  {rider.ratingCount === 1 ? "" : "s"}
                </p>
              )}
            </div>

            <div className="flex flex-col items-center">
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    onClick={() => pickRating(n)}
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    className="p-0.5 transition-transform active:scale-90">
                    <Star
                      size={38}
                      className={
                        n <= shown ? "fill-amber-400 text-amber-400" : "text-slate-300"
                      }
                    />
                  </button>
                ))}
              </div>
              <p className="mt-1.5 h-5 text-sm font-bold text-slate-700">
                {RIDER_STAR_WORDS[shown] || ""}
              </p>
            </div>

            {tagChoices.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400">
                  {rating >= 4 ? "What went well?" : "What went wrong?"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {tagChoices.map((tag) => {
                    const on = tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-bold transition",
                          on
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                        )}>
                        {riderTagLabel(tag)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="Add feedback for your rider (optional)"
              className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-400"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleLater}
                disabled={submitting}
                className="flex-1 h-11 rounded-xl border border-slate-200 text-sm font-bold text-slate-600 disabled:opacity-50">
                Maybe later
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={rating < 1 || submitting}
                className="flex-[2] h-11 rounded-xl bg-slate-900 text-sm font-bold text-white disabled:opacity-40">
                {submitting ? "Submitting…" : "Submit rating"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Opens the popup on its own for the latest delivered booking the customer
 * has not rated the rider for — for someone who closed the app before the
 * delivery finished. Mount once on a screen customers land on.
 */
export function PendingRiderRatingPrompt() {
  const [pending, setPending] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await parcelApi.getPendingRiderRating();
        const data = res.data?.result;
        if (cancelled || !data?.parcelId) return;
        if (isRiderRatingSnoozed(data.parcelId)) return;
        setPending(data);
        setOpen(true);
      } catch {
        /* nothing to rate, or offline — stay quiet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pending) return null;
  return (
    <RiderRatingPopup
      parcelId={pending.parcelId}
      open={open}
      onClose={() => setOpen(false)}
    />
  );
}
