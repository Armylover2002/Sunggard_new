import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bike, MapPin, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { parcelApi } from "../services/parcelApi";
import {
  Card, Label, Data, Barcode, StatusChip, EmptyNote, PrimaryButton,
} from "../components/sunguard/kit";
import { unwrapList } from "@core/api/unwrap";

/**
 * Every waybill the customer has, across both services.
 *
 * Local deliveries and outstation pickups sit in one list rather than behind
 * a second toggle: from the customer's side these are all just "parcels I
 * sent", and splitting them makes finding one harder, not easier. The service
 * shows as a line on each card.
 */

const TABS = [
  { value: "active", label: "Active" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];

const LOCAL_META = {
  REQUESTED: { tone: "idle", label: "Booked" },
  SEARCHING: { tone: "warn", label: "Finding Rider" },
  ACCEPTED: { tone: "transit", label: "Rider Assigned" },
  RIDER_ASSIGNED: { tone: "transit", label: "On The Way" },
  PICKUP_REACHED: { tone: "transit", label: "At Pickup" },
  PICKED_UP: { tone: "transit", label: "In Transit" },
  OUT_FOR_DELIVERY: { tone: "transit", label: "In Transit" },
  DROP_REACHED: { tone: "transit", label: "At Drop" },
  DELIVERY_FAILED: { tone: "fail", label: "Needs You" },
  RETURN_IN_TRANSIT: { tone: "warn", label: "Coming Back" },
  DELIVERED: { tone: "done", label: "Delivered" },
  RETURNED: { tone: "idle", label: "Returned" },
  CANCELLED: { tone: "idle", label: "Cancelled" },
};

/**
 * The outstation flow has its own, shorter lifecycle — there is no drop
 * receiver and no return leg, because the parcel is handed to a courier hub.
 * It used to render its raw enum with the underscores swapped for spaces,
 * so a customer read "RIDER ASSIGNED" and "OUT FOR DELIVERY" in caps next to
 * a local booking that said "On The Way". Same vocabulary, both services.
 */
const OUTSTATION_META = {
  REQUESTED: { tone: "idle", label: "Booked" },
  SEARCHING: { tone: "warn", label: "Finding Rider" },
  ACCEPTED: { tone: "transit", label: "Rider Assigned" },
  RIDER_ASSIGNED: { tone: "transit", label: "On The Way" },
  PICKUP_REACHED: { tone: "transit", label: "At Pickup" },
  PICKED_UP: { tone: "transit", label: "In Transit" },
  OUT_FOR_DELIVERY: { tone: "transit", label: "To The Hub" },
  DELIVERED: { tone: "done", label: "Handed To Courier" },
  CANCELLED: { tone: "idle", label: "Cancelled" },
};

const ACTIVE_LOCAL = new Set([
  "REQUESTED", "SEARCHING", "ACCEPTED", "RIDER_ASSIGNED", "PICKUP_REACHED",
  "PICKED_UP", "OUT_FOR_DELIVERY", "DROP_REACHED", "DELIVERY_FAILED",
  "RETURN_IN_TRANSIT",
]);

const bucketOf = (row) => {
  if (row.status === "CANCELLED") return "cancelled";
  if (row.status === "DELIVERED" || row.status === "RETURNED") return "delivered";
  return row.kind === "local"
    ? ACTIVE_LOCAL.has(row.status)
      ? "active"
      : "delivered"
    : "active";
};

const fmt = (date) =>
  date
    ? new Date(date).toLocaleString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "";

/* -------------------------------------------------------------------------- */

const WaybillCard = ({ row, onOpen }) => {
  const table = row.kind === "local" ? LOCAL_META : OUTSTATION_META;
  const meta =
    table[row.status] || {
      tone: "transit",
      label: (row.status || "").replace(/_/g, " "),
    };

  const isActive = bucketOf(row) === "active";

  return (
    <Card
      className={cn("p-4 transition", onOpen && "cursor-pointer active:scale-[0.995]")}
      onClick={onOpen ? () => onOpen(row) : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label>Waybill ID</Label>
          <Data className="mt-0.5 block text-[15px] font-semibold text-sg-ink">
            {row.reference}
          </Data>
        </div>
        <StatusChip tone={meta.tone} icon={isActive ? Bike : undefined}>
          {meta.label}
        </StatusChip>
      </div>

      <div className="mt-3 flex gap-2.5">
        <div className="flex flex-col items-center pt-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-sg-ink" />
          <span className="my-1 w-px flex-1 bg-sg-line-strong" />
          <span className="h-1.5 w-1.5 rounded-full border border-sg-line-strong" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="truncate text-[13px] font-semibold text-sg-ink">{row.from}</p>
          <p className="truncate text-[13px] text-sg-ink-2">{row.to}</p>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3 border-t border-sg-line pt-3">
        <div className="min-w-0">
          <Label>{isActive ? "Estimated" : "Completed"}</Label>
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] text-sg-ink">
            <Clock className="h-3.5 w-3.5 shrink-0 text-sg-ink-3" />
            <Data className="text-[12px]">{row.when}</Data>
          </p>
        </div>
        <Barcode value={row.reference} height={24} className="shrink-0 text-sg-ink-3" />
      </div>
    </Card>
  );
};

/* -------------------------------------------------------------------------- */

const WaybillHistory = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState("active");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // LOCAL CITY PARCEL DISABLED — history now only fetches outstation waybills.
    const [legacy] = await Promise.allSettled([parcelApi.getHistory()]);

    const out = [];

    if (legacy.status === "fulfilled") {
      const d = legacy.value?.data;
      const list = unwrapList({ data: d }, "parcels");
      for (const p of Array.isArray(list) ? list : []) {
        out.push({
          kind: "outstation",
          id: p._id,
          reference: `SG-${String(p._id).slice(-8).toUpperCase()}`,
          status: p.status,
          from: p.pickupAddress?.fullAddress || "Pickup",
          to: p.courierCompany
            ? `${p.courierCompany}${p.destinationCity ? ` · ${p.destinationCity}` : ""}`
            : "Courier hub",
          when: fmt(p.updatedAt || p.createdAt),
          sortAt: new Date(p.createdAt).getTime(),
        });
      }
    }

    out.sort((a, b) => b.sortAt - a.sortAt);
    setRows(out);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = { active: [], delivered: [], cancelled: [] };
    for (const row of rows) map[bucketOf(row)].push(row);
    return map;
  }, [rows]);

  const visible = grouped[tab] || [];

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-28 pt-4">
      <h1 className="sg-display text-[28px] text-sg-ink">Waybill History</h1>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
        {TABS.map((t) => {
          const active = tab === t.value;
          const count = (grouped[t.value] || []).length;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={cn(
                "sg-label shrink-0 rounded-full border px-4 py-2.5 transition",
                active
                  ? "border-transparent bg-sg-ink text-sg-ink-inverse"
                  : "border-sg-line bg-sg-surface text-sg-ink-2",
              )}
            >
              {t.label}
              {count ? ` · ${count}` : ""}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="mt-5 space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-[var(--sg-r-xl)] bg-sg-surface-2"
            />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-6">
          <EmptyNote
            title={
              tab === "active"
                ? "Nothing in transit"
                : tab === "delivered"
                  ? "Nothing delivered yet"
                  : "Nothing cancelled"
            }
            body={
              tab === "active"
                ? "Book a courier and it will show up here."
                : "Completed waybills collect here."
            }
            action={
              tab === "active" ? (
                <PrimaryButton onClick={() => navigate("/parcel/outstation")}>
                  Book a courier
                </PrimaryButton>
              ) : null
            }
          />
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {tab === "active" ? (
            <section className="space-y-3">
              <Label>In Transit</Label>
              {visible.map((row) => (
                <WaybillCard
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  onOpen={(r) =>
                    navigate(
                      r.kind === "local"
                        ? `/parcel/local/track/${r.id}`
                        : `/parcel/outstation/${r.id}`,
                    )
                  }
                />
              ))}
            </section>
          ) : (
            <section className="space-y-3">
              <Label>Previous</Label>
              {visible.map((row) => (
                <WaybillCard
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  onOpen={(r) =>
                    navigate(
                      r.kind === "local"
                        ? `/parcel/local/track/${r.id}`
                        : `/parcel/outstation/${r.id}`,
                    )
                  }
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export default WaybillHistory;
