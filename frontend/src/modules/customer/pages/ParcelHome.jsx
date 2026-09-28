import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Shield, TrendingUp, ArrowRight, MapPin, Clock,
} from "lucide-react";
import { parcelApi } from "../services/parcelApi";
import { createSocketTokenReader } from "@core/utils/authStorage";
import { STORAGE_KEYS } from "@core/utils/storage";
import { getOrderSocket } from "@core/services/orderSocket";
import {
  Card, Label, Data, Barcode, StatusChip, PrimaryButton,
  EmptyNote,
} from "../components/sunguard/kit";
import { unwrapList } from "@core/api/unwrap";
import PorterBannerCarousel from "../components/porter/PorterBannerCarousel";

const getCustomerToken = createSocketTokenReader(STORAGE_KEYS.AUTH_CUSTOMER);

/**
 * The parcel home — the outstation parcel flow is booked here.
 */

/* -------------------------------------------------------------------------- */

const ParcelHome = () => {
  const navigate = useNavigate();
  const [outstation, setOutstation] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const legacy = await parcelApi.getHistory().catch(() => null);
    if (legacy) {
      const d = legacy?.data;
      setOutstation(unwrapList({ data: d }, "parcels"));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    const getToken = getCustomerToken;
    getOrderSocket(getToken);
  }, [load]);

  const activeOutstation = useMemo(
    () => outstation.filter((p) => !["DELIVERED", "CANCELLED"].includes(p.status)),
    [outstation],
  );

  const active = activeOutstation;

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-28 pt-4">
      {/* ---- porter promotional banner carousel ---- */}
      <PorterBannerCarousel service="outstation" />

      {/* ---- start a shipment ---- */}
      <Card className="mt-5 overflow-hidden p-5">
        <span className="grid h-11 w-11 place-items-center rounded-[var(--sg-r)] bg-sg-surface-2">
          <Plus className="h-5 w-5 text-sg-ink" />
        </span>

        <h1 className="sg-display mt-4 text-[28px] text-sg-ink">Start a Shipment</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-sg-ink-2">
          We collect from you and hand it to your courier partner for the journey out of town.
        </p>

        <PrimaryButton
          className="mt-5"
          icon={ArrowRight}
          onClick={() => navigate("/parcel/outstation")}
        >
          Create New Booking
        </PrimaryButton>
      </Card>

      {/* ---- in-transit count ---- */}
      <Card className="mt-4 p-5">
        <div className="flex items-start justify-between">
          <Label>Parcels In Transit</Label>
          <Shield className="h-4 w-4 text-sg-ink-3" />
        </div>
        <Data className="mt-1 block text-[38px] font-bold leading-none text-sg-ink">
          {String(active.length).padStart(2, "0")}
        </Data>
        <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-sg-accent">
          <TrendingUp className="h-3.5 w-3.5" />
          {active.length ? "Everything on schedule" : "Nothing on the move"}
        </p>
      </Card>

      {/* ---- active list ---- */}
      <div className="mt-7 flex items-baseline justify-between gap-3">
        <h2 className="sg-heading text-[20px] text-sg-ink">Active Shipments</h2>
        <button
          type="button"
          onClick={() => navigate("/profile/parcel-history")}
          className="sg-label text-sg-ink-3 underline-offset-4 hover:underline"
        >
          Full History
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {loading ? (
          [0, 1].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-[var(--sg-r-xl)] bg-sg-surface-2"
            />
          ))
        ) : active.length === 0 ? (
          <EmptyNote
            title="No shipments moving"
            body="Book an outstation pickup and it will show up here."
          />
        ) : (
          active.map((parcel) => (
            <Card key={parcel._id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label>Waybill ID</Label>
                  <Data className="mt-0.5 block text-[15px] font-semibold text-sg-ink">
                    {String(parcel._id).slice(-10).toUpperCase()}
                  </Data>
                </div>
                <StatusChip tone="transit">
                  {(parcel.status || "").replace(/_/g, " ")}
                </StatusChip>
              </div>
              <div className="mt-3 flex items-center gap-2 text-[13px] text-sg-ink-2">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-sg-ink-3" />
                <span className="truncate">
                  {parcel.pickupAddress?.fullAddress?.split(",")[0]} →{" "}
                  {parcel.courierCompany || "Courier hub"}
                </span>
              </div>
              <div className="mt-3 flex items-end justify-between border-t border-sg-line pt-3">
                <div>
                  <Label>Estimated Pickup</Label>
                  <p className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] text-sg-ink">
                    <Clock className="h-3.5 w-3.5 text-sg-ink-3" />
                    {parcel.preferredPickupDate
                      ? new Date(parcel.preferredPickupDate).toLocaleDateString("en-IN", {
                          day: "numeric", month: "short",
                        })
                      : "Today"}
                  </p>
                </div>
                <Barcode value={parcel._id} height={26} className="text-sg-ink-3" />
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
};

export default ParcelHome;
