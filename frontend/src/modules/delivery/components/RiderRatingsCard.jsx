import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import RiderRatingsPanel from "@shared/components/RiderRatingsPanel";
import { deliveryApi } from "../services/deliveryApi";

/**
 * The rider's own view of what customers rated them: the overall rating, how
 * many ratings it rests on, the 5-to-1 breakdown and recent feedback.
 *
 * Collapsed to the headline until opened — the feedback list is only fetched
 * when a rider actually wants it.
 */
const PAGE_SIZE = 10;

export default function RiderRatingsCard() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (nextPage) => {
    setLoading(true);
    try {
      const res = await deliveryApi.getMyRatings({ page: nextPage, limit: PAGE_SIZE });
      const data = res.data?.result;
      if (!data) throw new Error("No data");
      setSummary(data.summary);
      setItems((current) => (nextPage === 1 ? data.items : [...current, ...data.items]));
      setPage(data.page || nextPage);
      setTotalPages(data.totalPages || 1);
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not load your ratings");
    } finally {
      setLoading(false);
    }
  }, []);

  // The headline is fetched up front (it is one small request); the full list
  // simply reuses the same response.
  useEffect(() => {
    load(1);
  }, [load]);

  const average = Number(summary?.average) || 0;
  const count = Number(summary?.count) || 0;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
            Customer ratings
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-lg font-black text-gray-900">
            <span className="text-yellow-400">★</span>
            {count > 0 ? average.toFixed(1) : "No ratings yet"}
            {count > 0 && (
              <span className="text-xs font-semibold text-gray-400">
                from {count} customer{count === 1 ? "" : "s"}
              </span>
            )}
          </p>
        </div>
        <span className="text-xs font-bold text-primary">{open ? "Hide" : "See feedback"}</span>
      </button>

      {open && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <RiderRatingsPanel
            summary={summary}
            items={items}
            loading={loading}
            hasMore={page < totalPages}
            onLoadMore={() => load(page + 1)}
            emptyText="Customers can rate you after each delivery. Their feedback will show here."
          />
        </div>
      )}
    </div>
  );
}
