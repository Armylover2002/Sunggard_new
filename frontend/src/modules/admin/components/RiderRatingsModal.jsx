import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Modal from "@shared/components/ui/Modal";
import RiderRatingsPanel from "@shared/components/RiderRatingsPanel";
import { adminApi } from "../services/adminApi";

/**
 * One rider's ratings, for the admin: the overall figure, how many ratings it
 * rests on, the 5-to-1 breakdown and every customer's feedback.
 *
 * Opened from the rating shown on the rider lists, so an admin sees the
 * number first and can open the reasons behind it.
 */
const PAGE_SIZE = 10;

export default function RiderRatingsModal({ rider, onClose }) {
  const riderId = rider?.id;
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (nextPage) => {
      if (!riderId) return;
      setLoading(true);
      try {
        const res = await adminApi.getRiderRatings(riderId, { page: nextPage, limit: PAGE_SIZE });
        const data = res.data?.result;
        if (!data) throw new Error("No data");
        setSummary(data.summary);
        setItems((current) => (nextPage === 1 ? data.items : [...current, ...data.items]));
        setPage(data.page || nextPage);
        setTotalPages(data.totalPages || 1);
      } catch (error) {
        toast.error(error?.response?.data?.message || "Could not load this rider's ratings");
      } finally {
        setLoading(false);
      }
    },
    [riderId],
  );

  useEffect(() => {
    setSummary(null);
    setItems([]);
    setPage(1);
    setTotalPages(1);
    if (riderId) load(1);
  }, [riderId, load]);

  if (!rider) return null;

  return (
    <Modal isOpen={Boolean(rider)} onClose={onClose} title={`${rider.name || "Rider"} — ratings`} size="md">
      <div className="max-h-[75vh] overflow-y-auto px-6 pb-6 pt-4">
        <RiderRatingsPanel
          summary={summary}
          items={items}
          loading={loading}
          hasMore={page < totalPages}
          onLoadMore={() => load(page + 1)}
          emptyText="No customer has rated this rider yet."
        />
      </div>
    </Modal>
  );
}
