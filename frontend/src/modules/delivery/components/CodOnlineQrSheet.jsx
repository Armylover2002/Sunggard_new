import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, CheckCircle2, QrCode, RefreshCw, Link2 } from "lucide-react";
import { toast } from "sonner";
import { deliveryApi } from "../services/deliveryApi";

/**
 * The customer booked cash-on-pickup, then wants to pay by UPI at the door.
 *
 * Showing a QR here rather than taking the cash means the money lands in the
 * platform's Razorpay account directly: the rider carries nothing, the
 * booking is recorded as an online payment rather than COD, and it never
 * enters the cash-deposit pipeline at all.
 *
 * There is no Razorpay webhook in this project, so payment is confirmed by
 * asking the backend to re-read the QR. That poll is deliberately slow (4s)
 * and stops the moment it reports paid or the sheet closes — a doorstep is a
 * couple of minutes, not an open-ended subscription.
 */

const POLL_INTERVAL_MS = 4000;

const CodOnlineQrSheet = ({ open, kind, bookingId, amount, onClose, onPaid }) => {
  const [qr, setQr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState("");

  // Held in a ref so the poll loop can stop itself without re-subscribing on
  // every tick, and so a late response can't act on a closed sheet.
  const activeRef = useRef(false);

  // Callers pass an inline arrow, so `onPaid` is a new function on every
  // parent render. Depending on it directly would tear down and restart the
  // interval each time — on a screen that re-renders with GPS updates, the
  // 4s tick could never actually fire.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  const createQr = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const res = await deliveryApi.createCodQr(kind, bookingId);
      setQr(res.data?.result || null);
    } catch (err) {
      const message =
        err?.response?.data?.message || "Could not create the payment QR";
      setError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }, [kind, bookingId]);

  useEffect(() => {
    if (!open || !bookingId) return undefined;

    activeRef.current = true;
    setPaid(false);
    setQr(null);
    createQr();

    return () => {
      activeRef.current = false;
    };
  }, [open, bookingId, createQr]);

  /** Poll only while a QR is on screen and unpaid. */
  useEffect(() => {
    if (!open || !qr?.paymentLinkUrl || paid) return undefined;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await deliveryApi.checkCodQr(kind, bookingId);
        if (cancelled || !activeRef.current) return;
        if (res.data?.result?.paid) {
          setPaid(true);
          toast.success("Payment received");
          onPaidRef.current?.();
        }
      } catch {
        /* a failed poll is not worth interrupting the rider for — the next
           tick, or the customer's own confirmation, will settle it */
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, qr?.paymentLinkUrl, paid, kind, bookingId]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center max-w-md mx-auto">
      <div className="w-full max-w-sm rounded-t-3xl bg-white p-5 sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-black text-slate-900">Customer pays online</h3>
            <p className="text-[11px] font-semibold text-slate-500">
              Money goes straight to the company
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {paid ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 size={56} className="text-emerald-500" />
            <p className="text-lg font-black text-slate-900">Payment received</p>
            <p className="text-[12px] font-semibold text-slate-500">
              This booking is now paid online. Do not collect cash.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full rounded-xl bg-slate-900 py-3 text-[13px] font-bold text-white"
            >
              Done
            </button>
          </div>
        ) : creating ? (
          <div className="flex flex-col items-center gap-3 py-12 text-slate-500">
            <Loader2 size={28} className="animate-spin" />
            <p className="text-[12px] font-semibold">Creating payment QR…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <QrCode size={40} className="text-slate-300" />
            <p className="text-[12px] font-semibold text-slate-600">{error}</p>
            <button
              type="button"
              onClick={createQr}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-[13px] font-bold text-slate-700"
            >
              <RefreshCw size={14} /> Try again
            </button>
            <p className="text-[11px] text-slate-400">
              You can still collect cash as usual.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-2xl border border-slate-200 p-3">
              {qr?.imageUrl ? (
                <img
                  src={qr.imageUrl}
                  alt="Scan to pay"
                  className="h-56 w-56 object-contain"
                />
              ) : (
                <div className="flex h-56 w-56 items-center justify-center text-slate-300">
                  <QrCode size={48} />
                </div>
              )}
            </div>

            <p className="text-2xl font-black text-slate-900">
              ₹{Number(amount || 0).toFixed(2)}
            </p>
            <p className="text-center text-[12px] font-semibold text-slate-500">
              Ask the customer to scan this with their phone's camera. It updates here on its own.
            </p>

            {qr?.paymentLinkUrl && (
              <a
                href={qr.paymentLinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-2.5 text-[12px] font-bold text-slate-700"
              >
                <Link2 size={14} /> Or pay by link instead
              </a>
            )}

            <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-700">
              <Loader2 size={12} className="animate-spin" />
              Waiting for payment…
            </div>

            <button
              type="button"
              onClick={onClose}
              className="mt-1 w-full rounded-xl bg-slate-100 py-3 text-[13px] font-bold text-slate-700"
            >
              Collect cash instead
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default CodOnlineQrSheet;
