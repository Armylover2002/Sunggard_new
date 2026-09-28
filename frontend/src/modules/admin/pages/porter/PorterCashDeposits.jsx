import React, { useCallback, useEffect, useState } from "react";
import {
  Banknote,
  Users,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCw,
  ImageIcon,
  AlertTriangle,
  Package,
  X,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import Card from "@shared/components/ui/Card";
import PageHeader from "@shared/components/ui/PageHeader";
import StatCard from "@shared/components/ui/StatCard";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import { cn } from "@/lib/utils";

/**
 * Rider COD cash: what the fleet is still holding, and the deposits waiting
 * on a decision.
 *
 * Approving here is the ONLY thing in the system that moves parcel COD
 * bookings to REMITTED_TO_ADMIN. Before this existed, cash collected at a
 * pickup had no path back — riders held it on the books indefinitely, and the
 * old admin cash screen could not see parcel cash at all. Rejecting leaves
 * every booking held, so the rider can raise a corrected request.
 */

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

const TABS = [
  { key: "PENDING", label: "Awaiting Review" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "all", label: "All" },
];

const STATUS_VARIANT = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "error",
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const PorterCashDeposits = () => {
  const [holdings, setHoldings] = useState(null);
  const [deposits, setDeposits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState("PENDING");
  const [page, setPage] = useState(1);

  const [review, setReview] = useState(null); // { deposit, approve }
  const [adminNote, setAdminNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [proofPreview, setProofPreview] = useState("");

  /**
   * Holdings barely change between tab switches, so it is fetched with the
   * list only on an explicit refresh or a decision — not on every paging tap.
   */
  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminPorterApi.getCashDeposits({ status: tab, page, limit: 20 });
      if (res.data.success) setDeposits(res.data.result);
    } catch (error) {
      toast.error(error?.response?.data?.message || "Couldn't load deposits");
    } finally {
      setLoading(false);
    }
  }, [tab, page]);

  const fetchHoldings = useCallback(async () => {
    try {
      const res = await adminPorterApi.getCashHoldings();
      if (res.data.success) setHoldings(res.data.result);
    } catch (error) {
      toast.error(error?.response?.data?.message || "Couldn't load cash holdings");
    }
  }, []);

  useEffect(() => {
    fetchDeposits();
  }, [fetchDeposits]);

  useEffect(() => {
    fetchHoldings();
  }, [fetchHoldings]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchDeposits(), fetchHoldings()]);
    setRefreshing(false);
  };

  const handleReview = async () => {
    if (!review) return;
    // A rejection without a reason leaves the rider with nothing to correct.
    if (!review.approve && !adminNote.trim()) {
      toast.error("Tell the rider why this was rejected");
      return;
    }

    setSubmitting(true);
    try {
      const res = await adminPorterApi.reviewCashDeposit(review.deposit.id, {
        approve: review.approve,
        adminNote: adminNote.trim(),
      });
      const result = res.data?.result || {};
      toast.success(
        review.approve
          ? `Cleared ${rupees(review.deposit.amount)} across ${
              result.parcelsRemitted || 0
            } bookings`
          : "Deposit rejected",
      );
      setReview(null);
      setAdminNote("");
      await Promise.all([fetchDeposits(), fetchHoldings()]);
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not record the decision");
    } finally {
      setSubmitting(false);
    }
  };

  const pending = deposits?.pending || { amount: 0, count: 0 };

  const stats = [
    {
      label: "Cash With Riders",
      value: rupees(holdings?.totalHeld),
      icon: Banknote,
      tint: "bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-900",
      note: `${holdings?.items?.length || 0} riders holding collected cash`,
    },
    {
      label: "Awaiting Review",
      value: rupees(pending.amount),
      icon: Clock,
      tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
      note: `${pending.count} deposit${pending.count === 1 ? "" : "s"} to check`,
    },
    {
      label: "Riders Holding",
      value: String(holdings?.items?.length || 0),
      icon: Users,
      tint: "bg-slate-500/10 text-slate-600 border-slate-200 dark:border-slate-700",
      note: "Cash not yet deposited",
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Rider Cash Deposits"
        description="COD cash riders collected at pickup. Approving a deposit is what clears those bookings."
        badge={<Badge variant="info">Porter Ops</Badge>}
        actions={
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 self-start rounded-2xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-primary/90"
          >
            <RotateCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <StatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            description={stat.note}
            icon={stat.icon}
            color={stat.tint.split(" ")[1]}
            bg={stat.tint}
          />
        ))}
      </div>

      {/**
        * Riders now deposit through the payment gateway, straight into the
        * platform's own account — so there is no UPI ID, QR or bank account
        * to publish here any more.
        *
        * What that removed: a screenshot-and-eyeball approval step that
        * proved nothing (an image is not a payment), and a manual bank
        * reconciliation for every deposit, because an out-of-band transfer
        * arrived with no reference tying it to a rider or to specific jobs.
        * Approving below now means approving against a captured payment.
        */}
      <Card className="border-orange-100 bg-orange-50/60 dark:border-orange-900/40 dark:bg-orange-950/20">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-orange-100 p-2.5 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Deposits arrive online
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              A rider taps Deposit and pays the full amount they are holding through the
              gateway, into the company account. Every deposit below is backed by a
              captured payment with a reference you can look up — approve it to clear the
              rider&apos;s bookings and let them take jobs again.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Deposit queue */}
        <Card className="overflow-hidden lg:col-span-2" contentClassName="p-0">
          <div className="flex flex-wrap gap-1.5 border-b border-slate-100 p-4 dark:border-slate-800">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key);
                  setPage(1);
                }}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  tab === t.key
                    ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex h-52 items-center justify-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          ) : (deposits?.items || []).length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={tab === "PENDING" ? "Nothing to review" : "No deposits here"}
              description={tab === "PENDING" ? "The fleet is settled up." : "No deposits match this filter yet."}
            />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {deposits.items.map((row) => (
                <div key={row.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-slate-900 dark:text-white">
                        {rupees(row.amount)}
                        <span className="ml-2 text-xs font-semibold text-slate-500">
                          {row.rider}
                        </span>
                      </p>
                      <p className="font-mono text-[11px] text-slate-400">
                        {row.riderPhone || "—"} · {row.method === "ONLINE" ? "Paid online" : row.method?.replace("_", " ")} ·{" "}
                        {formatDate(row.createdAt)}
                      </p>
                      {row.reference && (
                        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                          Ref: {row.reference}
                        </p>
                      )}
                      {row.note && (
                        <p className="mt-1 text-[11px] text-slate-500">“{row.note}”</p>
                      )}
                    </div>

                    <Badge variant={STATUS_VARIANT[row.status] || "gray"} className="uppercase">
                      {row.status}
                    </Badge>
                  </div>

                  {/* Which bookings this deposit clears */}
                  {row.items?.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {row.items.map((item) => (
                        <span
                          key={item.refId}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        >
                          <Package className="h-3 w-3" />
                          {item.label} · {rupees(item.amount)}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {row.proofImageUrl ? (
                      <button
                        onClick={() => setProofPreview(row.proofImageUrl)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                        View proof
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        No proof attached
                      </span>
                    )}

                    {row.status === "PENDING" && (
                      <>
                        <button
                          onClick={() => {
                            setReview({ deposit: row, approve: true });
                            setAdminNote("");
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-700 transition hover:bg-orange-500 hover:text-white dark:bg-orange-950/40 dark:text-orange-400"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </button>
                        <button
                          onClick={() => {
                            setReview({ deposit: row, approve: false });
                            setAdminNote("");
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 transition hover:bg-rose-500 hover:text-white dark:bg-rose-950/40 dark:text-rose-400"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </button>
                      </>
                    )}

                    {row.adminNote && (
                      <span className="text-[11px] text-slate-500">Note: {row.adminNote}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {deposits?.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 dark:border-slate-800">
              <p className="text-xs text-slate-500">
                Page {deposits.page} of {deposits.totalPages} · {deposits.total} deposits
              </p>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-40 dark:border-slate-700"
                >
                  Previous
                </button>
                <button
                  disabled={page >= deposits.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-40 dark:border-slate-700"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>

        {/* Who is holding what */}
        <Card className="overflow-hidden" contentClassName="p-0">
          <div className="border-b border-slate-100 p-4 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Cash with riders</h2>
            <p className="text-[11px] text-slate-400">
              Collected but not yet deposited, highest first.
            </p>
          </div>

          {(holdings?.items || []).length === 0 ? (
            <EmptyState
              icon={Users}
              title="No rider is holding cash"
              description="Every rider is settled up right now."
            />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {holdings.items.map((rider) => (
                <div key={rider.riderId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">
                      {rider.name}
                    </p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {rider.phone || "—"} · {rider.heldJobs} job
                      {rider.heldJobs === 1 ? "" : "s"}
                    </p>
                  </div>
                  <p className="shrink-0 font-mono text-xs font-bold text-slate-900 dark:text-white">
                    {rupees(rider.heldAmount)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Decision dialog */}
      {review && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              {review.approve ? "Approve this deposit?" : "Reject this deposit?"}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {review.approve
                ? `Confirms you received ${rupees(review.deposit.amount)} from ${
                    review.deposit.rider
                  }. The ${review.deposit.items?.length || 0} booking(s) it covers will be marked remitted.`
                : `${review.deposit.rider} keeps holding ${rupees(
                    review.deposit.amount,
                  )} and can submit a corrected deposit.`}
            </p>

            <textarea
              value={adminNote}
              onChange={(e) => setAdminNote(e.target.value)}
              rows={3}
              placeholder={review.approve ? "Note (optional)" : "Reason for rejection"}
              className="mt-3 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                disabled={submitting}
                onClick={() => setReview(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 disabled:opacity-50 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                disabled={submitting}
                onClick={handleReview}
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-60",
                  review.approve ? "bg-orange-600" : "bg-rose-600",
                )}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {review.approve ? "Approve & clear" : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Proof viewer */}
      {proofPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setProofPreview("")}
        >
          <div className="relative max-h-full max-w-lg overflow-auto">
            <button
              onClick={() => setProofPreview("")}
              className="absolute right-2 top-2 rounded-full bg-black/60 p-2 text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <img src={proofPreview} alt="Deposit proof" className="rounded-xl" />
          </div>
        </div>
      )}
    </div>
  );
};

export default PorterCashDeposits;
