import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Loader2, MapPin, Package, Truck, Phone, Clock,
  IndianRupee, ShieldCheck, Building2, Calendar,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { parcelApi } from "../services/parcelApi";
import { customerPorterApi } from "../services/customerPorterApi";
import InvoiceDownloadButton from "@shared/components/InvoiceDownloadButton";
import { unwrap } from "@core/api/unwrap";
import {
  Card, Label, Data, Barcode, StatusChip, Perforation, PrimaryButton,
} from "../components/sunguard/kit";

/**
 * One outstation waybill, in full.
 *
 * History listed these but could not open them — the card had no click
 * handler, so a customer could see that a booking existed and nothing more.
 * This is the read-only counterpart to the live search/tracking screen: what
 * was booked, what it cost, who is carrying it, and where it is now.
 */

const STATUS_META = {
  REQUESTED: { tone: "idle", label: "Booked" },
  SEARCHING: { tone: "warn", label: "Finding Rider" },
  ACCEPTED: { tone: "transit", label: "Rider Assigned" },
  RIDER_ASSIGNED: { tone: "transit", label: "On The Way" },
  PICKUP_REACHED: { tone: "transit", label: "At Pickup" },
  PICKED_UP: { tone: "transit", label: "Picked Up" },
  OUT_FOR_DELIVERY: { tone: "transit", label: "To Courier" },
  DELIVERED: { tone: "done", label: "Handed To Courier" },
  CANCELLED: { tone: "idle", label: "Cancelled" },
};

/**
 * The journey an outstation parcel actually takes, in order.
 *
 * `at` is a fallback for bookings made before the event timeline existed —
 * the real timestamp comes from `parcel.timeline` (one row per status
 * change, written as it happens) whenever that event is present.
 */
const TIMELINE = [
  { key: "REQUESTED", label: "Booked", at: (p) => p.createdAt },
  { key: "ACCEPTED", label: "Rider assigned", at: (p) => p.acceptedAt },
  { key: "PICKED_UP", label: "Collected from you", at: (p) => p.codSettlement?.riderCollectedAt || p.pickedUpAt },
  { key: "DELIVERED", label: "Handed to courier", at: (p) => p.deliveredAt },
];

const REACHED = {
  REQUESTED: 0, SEARCHING: 0,
  ACCEPTED: 1, RIDER_ASSIGNED: 1, PICKUP_REACHED: 1,
  PICKED_UP: 2, OUT_FOR_DELIVERY: 2,
  DELIVERED: 3,
};

const fmt = (date) =>
  date
    ? new Date(date).toLocaleString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : null;

const rupees = (n) => `₹${Number(n || 0).toFixed(2)}`;

const Row = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="shrink-0 text-[12px] text-sg-ink-3">{label}</span>
    <span className="min-w-0 text-right text-[13px] font-semibold text-sg-ink">{children}</span>
  </div>
);

const Section = ({ icon: Icon, title, children }) => (
  <Card className="p-4">
    <div className="mb-2 flex items-center gap-2">
      <Icon className="h-4 w-4 text-sg-ink-3" />
      <Label>{title}</Label>
    </div>
    {children}
  </Card>
);

const ParcelDetail = () => {
  const { parcelId } = useParams();
  const navigate = useNavigate();

  const [parcel, setParcel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await parcelApi.trackParcel(parcelId);
      setParcel(unwrap(res));
      setError("");
    } catch (err) {
      const message =
        err?.response?.status === 404
          ? "We couldn't find that waybill on your account."
          : err?.response?.data?.message || "Could not load this waybill.";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [parcelId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-sg-ink-3" />
      </div>
    );
  }

  if (error || !parcel) {
    return (
      <div className="mx-auto w-full max-w-lg px-5 pb-28 pt-6">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-sg-ink-2"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <Card className="p-6 text-center">
          <p className="text-[14px] font-semibold text-sg-ink">{error || "Waybill not found"}</p>
          <PrimaryButton className="mt-4" onClick={() => navigate("/profile/parcel-history")}>
            Back to history
          </PrimaryButton>
        </Card>
      </div>
    );
  }

  const reference = `SG-${String(parcel._id).slice(-8).toUpperCase()}`;
  const meta = STATUS_META[parcel.status] || STATUS_META.REQUESTED;
  const reached = REACHED[parcel.status] ?? 0;
  const cancelled = parcel.status === "CANCELLED";
  const isCod = String(parcel.paymentMethod).toUpperCase() === "COD";
  const breakdown = parcel.fareBreakdown || {};
  const rider = parcel.deliveryPartnerId;
  const courier = parcel.courierCompanyId;
  const pkg = parcel.packageDetails || {};

  // An outstation booking can cover a window of days; the customer is billed
  // per day, so showing only the total would look like the wrong number.
  const billableDays = Number(breakdown.billableDays) || 1;

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-28 pt-4">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-sg-ink-2"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* ---- waybill header ---- */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label>Waybill ID</Label>
            <Data className="mt-0.5 block text-[17px] font-semibold text-sg-ink">
              {reference}
            </Data>
            {/* Offered only once there is something to invoice — an unpaid
                online booking has not been sold yet. COD is invoiceable from
                the start, because the customer owes the fare regardless. */}
            {(parcel.paymentStatus === "PAID" || isCod) && !cancelled && (
              <InvoiceDownloadButton
                fetchInvoice={() => customerPorterApi.getBookingInvoice("parcel", parcel._id)}
                size="sm"
                className="mt-2"
              />
            )}
          </div>
          <StatusChip tone={meta.tone} icon={cancelled ? undefined : Truck}>
            {meta.label}
          </StatusChip>
        </div>

        <Perforation className="my-3" />

        <div className="flex items-end justify-between gap-3">
          <div>
            <Label>Booked</Label>
            <p className="mt-0.5 text-[13px] text-sg-ink">{fmt(parcel.createdAt)}</p>
          </div>
          <Barcode value={reference} height={28} className="shrink-0 text-sg-ink-3" />
        </div>
      </Card>

      {/* ---- where it is ---- */}
      {!cancelled && (
        <Card className="mt-3 p-4">
          <Label>Progress</Label>
          <ol className="mt-3 space-y-0">
            {TIMELINE.map((step, i) => {
              const done = i <= reached;
              // Prefer the real event's timestamp; fall back to the flat
              // field for a booking made before the timeline existed.
              const event = (parcel.timeline || []).find((e) => e.status === step.key);
              const at = fmt(event?.at || step.at(parcel));
              return (
                <li key={step.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        done ? "bg-sg-ink" : "border border-sg-line-strong bg-transparent",
                      )}
                    />
                    {i < TIMELINE.length - 1 && (
                      <span
                        className={cn(
                          "my-1 w-px flex-1",
                          i < reached ? "bg-sg-ink" : "bg-sg-line-strong",
                        )}
                      />
                    )}
                  </div>
                  <div className="flex-1 pb-4">
                    <p
                      className={cn(
                        "text-[13px] font-semibold",
                        done ? "text-sg-ink" : "text-sg-ink-3",
                      )}
                    >
                      {step.label}
                    </p>
                    {at && <p className="mt-0.5 text-[12px] text-sg-ink-3">{at}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      {cancelled && (
        <Card className="mt-3 border-sg-line p-4">
          <Label>Cancelled</Label>
          <p className="mt-1 text-[13px] text-sg-ink">
            {parcel.cancelReason || "This booking was cancelled."}
          </p>
          {parcel.cancelledAt && (
            <p className="mt-0.5 text-[12px] text-sg-ink-3">{fmt(parcel.cancelledAt)}</p>
          )}
        </Card>
      )}

      {/* ---- pickup ---- */}
      <div className="mt-3 space-y-3">
        <Section icon={MapPin} title="Picked up from">
          <p className="text-[14px] font-semibold text-sg-ink">
            {parcel.pickupAddress?.name || "—"}
          </p>
          {parcel.pickupAddress?.phone && (
            <a
              href={`tel:${parcel.pickupAddress.phone}`}
              className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-sg-ink-2"
            >
              <Phone className="h-3 w-3" /> {parcel.pickupAddress.phone}
            </a>
          )}
          <p className="mt-1 text-[13px] leading-relaxed text-sg-ink-2">
            {parcel.pickupAddress?.fullAddress}
          </p>
        </Section>

        {/* ---- onward courier ---- */}
        <Section icon={Building2} title="Handed to">
          <Row label="Courier">{parcel.courierCompany || "—"}</Row>
          <Row label="Destination">{parcel.destinationCity || "—"}</Row>
          {courier?.name && <Row label="Drop location">{courier.name}</Row>}
          {courier?.phone && (
            <a
              href={`tel:${courier.phone}`}
              className="mt-0.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-sg-ink-2"
            >
              <Phone className="h-3 w-3" /> {courier.phone}
            </a>
          )}
        </Section>

        {/* ---- what was sent ---- */}
        <Section icon={Package} title="Package">
          <Row label="Type">
            {pkg.packageCategory || pkg.packageType || "—"}
          </Row>
          {pkg.packageSegment && <Row label="Segment">{pkg.packageSegment}</Row>}
          <Row label="Weight">{parcel.weight ? `${parcel.weight} kg` : "—"}</Row>
          <Row label="Speed">
            {parcel.deliverySpeed === "express" ? "Express" : "Normal"}
          </Row>
          {pkg.description && (
            <p className="mt-1.5 border-t border-sg-line pt-2 text-[12px] leading-relaxed text-sg-ink-2">
              {pkg.description}
            </p>
          )}
        </Section>

        {/* ---- pickup window ---- */}
        {(parcel.preferredPickupDate || parcel.pickupWindow) && (
          <Section icon={Calendar} title="Pickup window">
            <Row label="Booked for">
              {parcel.preferredPickupDate
                ? new Date(parcel.preferredPickupDate).toLocaleDateString("en-IN", {
                    day: "numeric", month: "short", year: "numeric",
                  })
                : "Any day"}
            </Row>
            {billableDays > 1 && <Row label="Days covered">{billableDays}</Row>}
          </Section>
        )}

        {/* ---- money ---- */}
        <Section icon={IndianRupee} title="Payment">
          {Number(breakdown.distanceFare) > 0 && (
            <Row label={`Distance${billableDays > 1 ? " (per day)" : ""}`}>
              {rupees(breakdown.distanceFare)}
            </Row>
          )}
          {Number(breakdown.weightFare) > 0 && (
            <Row label={`Weight${billableDays > 1 ? " (per day)" : ""}`}>
              {rupees(breakdown.weightFare)}
            </Row>
          )}
          {Number(breakdown.platformCharge) > 0 && (
            <Row label="Courier fee">{rupees(breakdown.platformCharge)}</Row>
          )}
          {Number(breakdown.expressCharge) > 0 && (
            <Row label="Express">{rupees(breakdown.expressCharge)}</Row>
          )}
          {billableDays > 1 && Number(breakdown.dailyFare) > 0 && (
            <Row label={`Per day × ${billableDays}`}>{rupees(breakdown.dailyFare)}</Row>
          )}

          <div className="mt-2 flex items-baseline justify-between border-t border-sg-line pt-2">
            <span className="text-[13px] font-semibold text-sg-ink">Total</span>
            <Data className="text-[16px] font-semibold text-sg-ink">
              {rupees(parcel.fare)}
            </Data>
          </div>

          <div className="mt-2 flex items-center justify-between">
            <span className="text-[12px] text-sg-ink-3">
              {isCod ? "Cash on pickup" : parcel.paymentMethod}
            </span>
            <StatusChip tone={parcel.paymentStatus === "PAID" ? "done" : "warn"}>
              {parcel.paymentStatus === "PAID" ? "Paid" : "Pending"}
            </StatusChip>
          </div>
        </Section>

        {/* ---- rider ---- */}
        {rider?.name && (
          <Section icon={Truck} title="Your rider">
            <p className="text-[14px] font-semibold text-sg-ink">{rider.name}</p>
            <p className="mt-0.5 text-[12px] text-sg-ink-3">
              {[rider.vehicleType, rider.vehicleNumber].filter(Boolean).join(" · ")}
            </p>
            {rider.phone && (
              <a
                href={`tel:${rider.phone}`}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-sg-surface-2 px-3 py-2 text-[12px] font-semibold text-sg-ink"
              >
                <Phone className="h-3.5 w-3.5" /> Call rider
              </a>
            )}
          </Section>
        )}

        {/* ---- pickup code, while it still matters ---- */}
        {parcel.otp && reached < 2 && !cancelled && (
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-sg-ink-3" />
              <Label>Pickup code</Label>
            </div>
            <Data className="text-[24px] tracking-[0.3em] text-sg-ink">{parcel.otp}</Data>
            <p className="mt-1 text-[12px] text-sg-ink-3">
              Share this with the rider only when they collect the courier.
            </p>
          </Card>
        )}

        {/* ---- live tracking, only while there is something to track ---- */}
        {!cancelled && reached < 3 && (
          <PrimaryButton
            icon={Clock}
            onClick={() => navigate(`/parcel/search/${parcel._id}`)}
          >
            Track live
          </PrimaryButton>
        )}
      </div>
    </div>
  );
};

export default ParcelDetail;
