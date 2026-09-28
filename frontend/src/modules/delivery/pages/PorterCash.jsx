import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  IndianRupee,
  RotateCw,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  Info,
  ShieldAlert,
  Gauge,
  Package,
  MapPin,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import Card from "@/shared/components/ui/Card";
import Button from "@/shared/components/ui/Button";
import { openRazorpayCheckout } from "@shared/utils/razorpayCheckout";
import { deliveryApi } from "../services/deliveryApi";
import { cn } from "@/lib/utils";

/**
 * The rider's COD cash: what they are holding, how much they are allowed to
 * hold, and paying it back.
 *
 * Two things changed here.
 *
 * The cash LIMIT is now real. A rider may hold up to a set amount; at that
 * point they stop being offered work — local and outstation both — until they
 * deposit and an admin approves. This screen shows the meter continuously,
 * not only once the block lands. A rider whose jobs simply stopped appearing,
 * with no explanation, has been failed by the product.
 *
 * DEPOSITING is now online. The old flow published an admin UPI ID / QR /
 * bank account, the rider transferred out of band, uploaded a screenshot, and
 * an admin eyeballed it. A screenshot is not a payment: nothing in the system
 * knew whether money had moved, so "approval" was a guess, and every deposit
 * was a manual bank reconciliation. Now the rider taps once, pays the full
 * held amount through the gateway into the platform's own account, and the
 * admin approves against a captured payment.
 *
 * Distinct from the older "COD Cash" screen, which is grocery-order cash.
 */

const RUPEE = "₹";

const STATUS_STYLES = {
  PENDING: {
    icon: Clock,
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    label: "Awaiting approval",
  },
  APPROVED: {
    icon: CheckCircle2,
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "Approved",
  },
  REJECTED: {
    icon: XCircle,
    cls: "bg-red-50 text-red-700 border-red-200",
    label: "Rejected",
  },
};

const money = (value) => `${RUPEE}${Number(value || 0).toLocaleString("en-IN")}`;

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const PorterCash = () => {
  const navigate = useNavigate();

  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  /**
   * One call for the meter and the deposit quote, one for the history.
   *
   * The status endpoint returns both the limit picture and what is
   * depositable, precisely so this screen cannot show a meter and a deposit
   * button that disagree about how much cash there is.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, historyRes, profileRes] = await Promise.all([
        deliveryApi.getCashStatus(),
        deliveryApi.getCashDeposits({ limit: 20 }),
        // Only for prefilling the checkout sheet, so a failure here must not
        // stop a rider from seeing their balance.
        deliveryApi.getProfile().catch(() => null),
      ]);

      setStatus(statusRes.data?.result || null);
      setHistory(historyRes.data?.result?.items || []);
      setProfile(profileRes?.data?.result || null);
    } catch (error) {
      toast.error(error?.response?.data?.message || "Couldn't load your cash summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deposit = status?.deposit || {};
  const depositable = Number(deposit.depositableAmount || 0);
  const items = Array.isArray(deposit.items) ? deposit.items : [];

  /**
   * Open the gateway, then confirm the receipt.
   *
   * The amount is never sent from here — the server sums it from the bookings
   * the rider actually holds. A client-supplied amount would let a rider clear
   * ₹5,000 of jobs by paying ₹1.
   */
  const handleDeposit = async () => {
    if (paying) return;

    setPaying(true);
    try {
      const { data } = await deliveryApi.startOnlineDeposit();
      const order = data?.result?.razorpay;
      if (!order?.orderId) throw new Error("Could not start the deposit");

      let receipt;
      try {
        receipt = await openRazorpayCheckout({
          keyId: order.keyId,
          orderId: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: "Cash deposit",
          description: `Depositing ${money(data?.result?.amount ?? depositable)} collected on COD jobs`,
          prefill: {
            name: profile?.name || "",
            contact: String(profile?.phone || "").replace(/\s/g, ""),
            email: profile?.email || "",
          },
          themeColor: "#ea580c",
        });
      } catch (checkoutError) {
        // Dismissing the sheet is not a failure — the gateway order stays open
        // and tapping Deposit again resumes the same one, so there is nothing
        // to warn about and nothing lost.
        if (checkoutError?.code === "CHECKOUT_DISMISSED") {
          toast.info("Deposit cancelled — your cash is still with you");
          return;
        }
        throw checkoutError;
      }

      await deliveryApi.verifyOnlineDeposit(receipt);
      toast.success("Deposit verified and cleared");
      await load();
    } catch (error) {
      toast.error(
        error?.response?.data?.message || error?.message || "Could not complete the deposit",
      );
    } finally {
      setPaying(false);
    }
  };

  const limit = Number(status?.limit || 0);
  const held = Number(status?.held || 0);
  const remaining = Number(status?.remaining || 0);
  const usedPercent = Number(status?.usedPercent || 0);
  const blocked = Boolean(status?.blocked);
  const warning = Boolean(status?.warning);
  const enforced = Boolean(status?.limitEnforced);

  const meterColor = blocked
    ? "bg-red-500"
    : warning
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <div className="min-h-screen bg-gray-50/50 pb-28">
      <div className="sticky top-0 z-30 bg-white shadow-sm">
        <div className="flex items-center gap-2 p-4">
          <button
            onClick={() => navigate(-1)}
            className="rounded-full p-2 transition-colors hover:bg-gray-100"
            aria-label="Go back"
          >
            <ArrowLeft size={20} className="text-gray-700" />
          </button>
          <div className="flex-1">
            <h1 className="ds-h3 text-gray-900">Cash Deposit</h1>
            <p className="text-xs text-gray-500">Cash you collected on COD jobs</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            disabled={loading}
            onClick={load}
            aria-label="Refresh"
          >
            <RotateCw
              size={18}
              className={loading ? "animate-spin text-gray-400" : "text-gray-600"}
            />
          </Button>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-lg space-y-5 p-4"
      >
        {/**
          * The block, stated first and in plain words.
          *
          * This is the single most important thing on the screen for a rider
          * whose jobs have stopped, and it has to answer "why" and "what do I
          * do" in one read.
          */}
        {blocked && (
          <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4">
            <Lock size={18} className="mt-0.5 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-bold text-red-900">New jobs are paused</p>
              <p className="mt-1 text-xs leading-relaxed text-red-800">
                {status?.reason ||
                  "You have reached your cash limit. Deposit the cash to start receiving jobs again."}
              </p>
            </div>
          </div>
        )}

        {!blocked && warning && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-xs leading-relaxed font-semibold text-amber-800">
              {status?.reason}
            </p>
          </div>
        )}

        {/* The meter */}
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Cash with you
              </p>
              <p className="mt-1 text-3xl font-extrabold text-gray-900">{money(held)}</p>
            </div>
            <div className="rounded-xl bg-orange-50 p-3 text-orange-600">
              <IndianRupee size={22} />
            </div>
          </div>

          {enforced ? (
            <div className="mt-4">
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(usedPercent, 100)}%` }}
                  className={cn("h-full rounded-full", meterColor)}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] font-bold">
                <span className="text-gray-500">
                  {usedPercent}% of your {money(limit)} limit
                </span>
                <span className={cn(remaining <= 0 ? "text-red-600" : "text-emerald-600")}>
                  {money(remaining)} left
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-gray-500">
              Collected from customers on COD jobs. Deposit it online — it clears instantly.
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
              <div className="flex items-center gap-1.5">
                <MapPin size={12} className="text-gray-400" />
                <p className="text-[11px] font-bold uppercase text-gray-500">Local</p>
              </div>
              <p className="text-lg font-bold text-gray-900">{money(status?.heldLocal)}</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
              <div className="flex items-center gap-1.5">
                <Package size={12} className="text-gray-400" />
                <p className="text-[11px] font-bold uppercase text-gray-500">Outstation</p>
              </div>
              <p className="text-lg font-bold text-gray-900">
                {money(status?.heldOutstation)}
              </p>
            </div>
          </div>

          {Number(status?.pendingDepositAmount) > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <Clock size={14} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-xs font-semibold text-amber-800">
                {money(status.pendingDepositAmount)} is with the admin for approval.
                {enforced ? " Jobs resume once it is approved." : ""}
              </p>
            </div>
          )}
        </Card>

        {/* Deposit */}
        <Card className="p-5">
          <h3 className="font-bold text-gray-900">Deposit your cash</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            You pay the full amount you are holding, straight to the company. Your
            balance clears the moment the payment goes through.
          </p>

          {items.length > 0 ? (
            <>
              <div className="mt-4 space-y-2">
                {items.map((item) => (
                  <div
                    key={item.refId}
                    className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-gray-900">{item.label}</p>
                      <p className="text-[11px] text-gray-500">
                        Collected {formatDate(item.collectedAt)}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-extrabold text-gray-900">
                      {money(item.amount)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between rounded-xl bg-gray-900 p-4 text-white">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide opacity-60">
                    Total to deposit
                  </p>
                  <p className="text-2xl font-extrabold">{money(depositable)}</p>
                </div>
                <Gauge size={28} className="opacity-30" />
              </div>

              {/**
                * The full amount, always. Letting a rider pay a slice would
                * leave them permanently near the ceiling and turn the limit
                * into a nuisance rather than a control — so the button says so
                * rather than offering a choice that does not exist.
                */}
              <button
                type="button"
                onClick={handleDeposit}
                disabled={paying}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-600 py-4 text-sm font-extrabold text-white shadow-lg transition-all active:scale-[0.98] disabled:opacity-60"
              >
                {paying ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Opening payment...
                  </>
                ) : (
                  <>Deposit {money(depositable)}</>
                )}
              </button>

              <p className="mt-2 text-center text-[11px] text-gray-400">
                Pay by UPI, card or net banking. Your balance clears the moment the
                payment is verified.
              </p>
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-6 text-center">
              {Number(deposit.awaitingReviewAmount) > 0 ? (
                <>
                  <Clock size={22} className="mx-auto mb-2 text-amber-500" />
                  <p className="text-sm font-semibold text-gray-600">
                    {money(deposit.awaitingReviewAmount)} is already with the admin
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Nothing more to deposit until it is reviewed.
                  </p>
                </>
              ) : (
                <>
                  <CheckCircle2 size={22} className="mx-auto mb-2 text-emerald-500" />
                  <p className="text-sm font-semibold text-gray-600">
                    No cash pending deposit
                  </p>
                  <p className="mt-1 text-xs text-gray-400">You are all clear.</p>
                </>
              )}
            </div>
          )}
        </Card>

        {/* History */}
        <Card className="p-5">
          <h3 className="font-bold text-gray-900">Your deposits</h3>

          <div className="mt-3 space-y-2">
            {history.map((row) => {
              const style = STATUS_STYLES[row.status] || STATUS_STYLES.PENDING;
              const StatusIcon = style.icon;
              return (
                <div
                  key={row.id}
                  className="rounded-xl border border-gray-100 bg-white p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-extrabold text-gray-900">
                        {money(row.amount)}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {formatDate(row.createdAt)}
                        {row.method ? ` · ${row.method === "ONLINE" ? "Online" : row.method}` : ""}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold",
                        style.cls,
                      )}
                    >
                      <StatusIcon size={11} />
                      {style.label}
                    </span>
                  </div>

                  {row.adminNote && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-gray-50 p-2">
                      <Info size={12} className="mt-0.5 shrink-0 text-gray-400" />
                      <p className="text-[11px] text-gray-600">{row.adminNote}</p>
                    </div>
                  )}
                </div>
              );
            })}

            {!loading && history.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
                No deposits yet.
              </div>
            )}
          </div>
        </Card>
      </motion.div>
    </div>
  );
};

export default PorterCash;
