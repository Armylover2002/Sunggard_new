import React from "react";
import { Star } from "lucide-react";
import { riderTagLabel } from "@shared/constants/riderRating";

/**
 * A rider's overall rating, how it breaks down, and the feedback behind it.
 *
 * Pure display — the rider's own app and the admin panel each fetch their own
 * data (different endpoints, different auth) and hand it here, so a rider and
 * an admin always see the figures laid out the same way.
 *
 *   summary: { average, count, distribution: { 5: n, 4: n, ... } }
 *   items:   [{ id, rating, tags, comment, customerName, reference, createdAt }]
 */

export const Stars = ({ value = 0, size = 14 }) => (
  <span className="inline-flex items-center gap-0.5">
    {[1, 2, 3, 4, 5].map((n) => (
      <Star
        key={n}
        size={size}
        className={n <= Math.round(value) ? "fill-amber-400 text-amber-400" : "text-slate-300"}
      />
    ))}
  </span>
);

const formatWhen = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

export default function RiderRatingsPanel({
  summary,
  items = [],
  loading = false,
  hasMore = false,
  onLoadMore,
  emptyText = "No ratings yet.",
}) {
  const average = Number(summary?.average) || 0;
  const count = Number(summary?.count) || 0;
  const distribution = summary?.distribution || {};

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5 rounded-2xl bg-slate-50 p-4">
        <div className="text-center shrink-0">
          <p className="text-4xl font-black text-slate-900 leading-none">
            {count ? average.toFixed(1) : "—"}
          </p>
          <div className="mt-1.5 flex justify-center">
            <Stars value={average} size={14} />
          </div>
          <p className="mt-1 text-[11px] font-semibold text-slate-500">
            {count} rating{count === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex-1 space-y-1">
          {[5, 4, 3, 2, 1].map((star) => {
            const n = Number(distribution[star]) || 0;
            const pct = count ? Math.round((n / count) * 100) : 0;
            return (
              <div key={star} className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
                <span className="w-3 text-right">{star}</span>
                <Star size={10} className="fill-amber-400 text-amber-400" />
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-6 text-right tabular-nums">{n}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400">
          Customer feedback
        </p>
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
            {loading ? "Loading…" : emptyText}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
            {items.map((item) => (
              <li key={item.id} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <Stars value={item.rating} size={13} />
                  <span className="text-[11px] text-slate-400">{formatWhen(item.createdAt)}</span>
                </div>
                {item.tags?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                        {riderTagLabel(tag)}
                      </span>
                    ))}
                  </div>
                )}
                {item.comment && (
                  <p className="mt-2 text-sm leading-relaxed text-slate-700">“{item.comment}”</p>
                )}
                <p className="mt-2 text-[11px] text-slate-400">
                  {item.customerName}
                  {item.customerPhone ? ` · ${item.customerPhone}` : ""}
                  {item.reference ? ` · ${item.reference}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="mt-3 w-full rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600 disabled:opacity-50">
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}
