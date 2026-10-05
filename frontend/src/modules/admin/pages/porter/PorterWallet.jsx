import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Wallet,
  TrendingUp,
  Users,
  AlertTriangle,
  Banknote,
  Clock,
  CheckCircle2,
  Loader2,
  RotateCw,
  ArrowRight,
  Info,
  QrCode,
  Eye,
  BadgeCheck,
  Bike,
  MapPin,
  Mail,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import Card from "@shared/components/ui/Card";
import ConfirmDialog from "@shared/components/ui/ConfirmDialog";
import Modal from "@shared/components/ui/Modal";
import PageHeader from "@shared/components/ui/PageHeader";
import StatCard from "@shared/components/ui/StatCard";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import { adminFinanceApi } from "../../services/api/financeApi";
import { cn } from "@/lib/utils";

/**
 * The porter desk's money picture: revenue in, what riders earned from it,
 * what that leaves the platform, and — separately and honestly labelled —
 * the rider wallet/withdrawal state, which pools porter and grocery work
 * together (see backend porterPayoutsController.js for why that can't be
 * split by service).
 */

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

const WITHDRAWAL_TABS = [
  { key: "pending", label: "Payment Ready" },
  { key: "settled", label: "Paid" },
  { key: "all", label: "All" },
];

/**
 * Where this rider's money actually goes.
 *
 * The admin used to approve withdrawals with only a name and an amount on
 * screen, then hunt for account details elsewhere. Whatever the rider saved
 * in their own payout settings travels with the request and is shown here.
 */
const PayoutDestination = ({ payout }) => {
  const p = payout || {};
  const hasBank = Boolean(p.accountNumber && p.ifsc);

  if (!hasBank && !p.upiId && !p.qrImageUrl) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600">
        <AlertTriangle className="h-3.5 w-3.5" />
        No payout details
      </span>
    );
  }

  return (
    <div className="space-y-0.5">
      {p.upiId && (
        <p className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
          UPI · {p.upiId}
        </p>
      )}
      {hasBank && (
        <>
          <p className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
            A/C · {p.accountNumber}
          </p>
          <p className="text-[10px] text-slate-400">
            {p.ifsc}
            {p.bankName ? ` · ${p.bankName}` : ""}
            {p.accountHolder ? ` · ${p.accountHolder}` : ""}
          </p>
        </>
      )}
      {p.qrImageUrl && (
        <a
          href={p.qrImageUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-bold text-primary hover:underline"
        >
          <QrCode className="h-3 w-3" />
          View QR
        </a>
      )}
    </div>
  );
};

const DetailRow = ({ icon: IconCmp, label, value, mono = false }) => {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <IconCmp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
        <p className={cn("break-all text-xs font-semibold text-slate-800 dark:text-slate-200", mono && "font-mono")}>
          {value}
        </p>
      </div>
    </div>
  );
};

/**
 * The full picture for a single withdrawal row, opened via "View" so the
 * admin knows exactly who they're paying — not just a name in a table cell —
 * and can see every payout detail in full, nothing masked or link-only.
 */
const WithdrawalDetailModal = ({ row, onClose }) => {
  const p = row?.payout || {};
  const hasBank = Boolean(p.accountNumber && p.ifsc);
  const hasPayout = hasBank || p.upiId || p.qrImageUrl;

  return (
    <Modal isOpen={Boolean(row)} onClose={onClose} title="Rider & Payout Details" size="md">
      {row && (
        <div className="space-y-5">
          {/* Rider identity */}
          <div className="flex items-center gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/50">
            {row.riderProfileImage ? (
              <img
                src={row.riderProfileImage}
                alt={row.rider}
                className="h-16 w-16 shrink-0 rounded-2xl border border-slate-200 object-cover dark:border-slate-700"
              />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-slate-200 text-lg font-black text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                {(row.rider || "R").charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-base font-extrabold text-slate-900 dark:text-white">{row.rider}</p>
                {row.riderVerified && <BadgeCheck className="h-4 w-4 shrink-0 text-orange-500" />}
              </div>
              <p className="font-mono text-xs text-slate-500">{row.riderPhone || "—"}</p>
              {row.riderVehicleType && (
                <p className="mt-0.5 text-[11px] capitalize text-slate-400">
                  {row.riderVehicleType}
                  {row.riderVehicleNumber ? ` · ${row.riderVehicleNumber}` : ""}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-x-4 gap-y-0 sm:grid-cols-2">
            <DetailRow icon={Phone} label="Phone" value={row.riderPhone} mono />
            <DetailRow icon={Mail} label="Email" value={row.riderEmail} />
            <DetailRow icon={MapPin} label="Area" value={row.riderArea} />
            <DetailRow icon={Bike} label="Vehicle" value={row.riderVehicleNumber || row.riderVehicleType} mono />
          </div>

          {/* Amount + status */}
          <div className="flex items-center justify-between rounded-2xl border border-slate-100 p-4 dark:border-slate-800">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Withdrawal Amount</p>
              <p className="font-mono text-xl font-extrabold text-slate-900 dark:text-white">{rupees(row.amount)}</p>
            </div>
            <Badge variant={row.status === "Settled" ? "success" : "warning"}>
              {row.status}
            </Badge>
          </div>

          {/* Payout destination, in full */}
          <div className="rounded-2xl border border-slate-100 p-4 dark:border-slate-800">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Pay To</p>
            {!hasPayout ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
                <AlertTriangle className="h-4 w-4" />
                Rider hasn't saved any payout details
              </span>
            ) : (
              <div className="space-y-3">
                {p.upiId && (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">UPI ID</p>
                    <p className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{p.upiId}</p>
                  </div>
                )}
                {hasBank && (
                  <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Account Number</p>
                      <p className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{p.accountNumber}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">IFSC</p>
                      <p className="font-mono text-sm font-bold text-slate-800 dark:text-slate-200">{p.ifsc}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Account Holder</p>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{p.accountHolder || "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Bank</p>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{p.bankName || "—"}</p>
                    </div>
                  </div>
                )}
                {p.qrImageUrl && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Collect QR</p>
                    <a href={p.qrImageUrl} target="_blank" rel="noreferrer" className="inline-block">
                      <img
                        src={p.qrImageUrl}
                        alt="Rider payout QR"
                        className="h-40 w-40 rounded-xl border border-slate-200 object-contain dark:border-slate-700"
                      />
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

const PorterWallet = () => {
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  const [withdrawals, setWithdrawals] = useState(null);
  const [withdrawalsLoading, setWithdrawalsLoading] = useState(true);
  const [statusTab, setStatusTab] = useState("pending");
  const [page, setPage] = useState(1);

  const [refreshing, setRefreshing] = useState(false);
  const [settleTarget, setSettleTarget] = useState(null);
  const [settling, setSettling] = useState(false);
  const [viewTarget, setViewTarget] = useState(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await adminPorterApi.getWalletOverview();
      if (res.data.success) setOverview(res.data.result);
    } catch (error) {
      console.error("Courier wallet overview error:", error);
      toast.error(error?.response?.data?.message || "Couldn't load wallet overview");
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const fetchWithdrawals = useCallback(async () => {
    setWithdrawalsLoading(true);
    try {
      const res = await adminPorterApi.getWalletWithdrawals({
        status: statusTab,
        page,
        limit: 20,
      });
      if (res.data.success) setWithdrawals(res.data.result);
    } catch (error) {
      console.error("Courier wallet withdrawals error:", error);
      toast.error(error?.response?.data?.message || "Couldn't load withdrawal requests");
    } finally {
      setWithdrawalsLoading(false);
    }
  }, [statusTab, page]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    fetchWithdrawals();
  }, [fetchWithdrawals]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchOverview(), fetchWithdrawals()]);
    setRefreshing(false);
  };

  const handleConfirmSettle = async () => {
    if (!settleTarget) return;
    setSettling(true);
    try {
      await adminFinanceApi.settleTransaction(settleTarget.id);
      toast.success(`Marked ${rupees(settleTarget.amount)} as paid to ${settleTarget.rider}`);
      setSettleTarget(null);
      await Promise.all([fetchOverview(), fetchWithdrawals()]);
    } catch (error) {
      console.error("Settle transaction error:", error);
      toast.error(error?.response?.data?.message || "Failed to mark as paid");
    } finally {
      setSettling(false);
    }
  };

  const revenue = overview?.revenue || {};
  const adminEarning = overview?.adminEarning || {};
  const riderEarning = overview?.riderEarning || {};
  const withheld = overview?.withheld || {};
  const wallet = overview?.wallet || {};
  const riders = overview?.riders || [];

  const moneyStats = [
    {
      label: "Courier Revenue",
      value: rupees(revenue.total),
      icon: TrendingUp,
      color: "text-orange-600",
      bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
      note: `Outstation ${rupees(revenue.pickup)} · Local ${rupees(revenue.city)}`,
    },
    {
      label: "Rider Earning",
      value: rupees(riderEarning.total),
      icon: Users,
      color: "text-orange-600",
      bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
      note: `${riderEarning.riders || 0} riders earned from courier jobs`,
    },
    {
      label: "Admin Earning",
      value: rupees(adminEarning.total),
      icon: Wallet,
      color: "text-orange-600",
      bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
      note: `${adminEarning.marginPercent || 0}% margin on courier revenue`,
    },
    {
      label: "Held Back",
      value: rupees(withheld.amount),
      icon: AlertTriangle,
      color: "text-amber-600",
      bg: "bg-amber-500/10 border border-amber-200 dark:border-amber-900",
      note: `${withheld.count || 0} deliveries awaiting review`,
    },
  ];

  const walletStats = [
    {
      label: "Wallet Balance",
      value: rupees(wallet.totalBalance),
      icon: Wallet,
      color: "text-slate-600",
      bg: "bg-slate-500/10 border border-slate-200 dark:border-slate-700",
      note: "All services, not courier alone",
    },
    {
      label: "Ready to Pay",
      value: rupees(wallet.pendingWithdrawals),
      icon: Clock,
      color: "text-amber-600",
      bg: "bg-amber-500/10 border border-amber-200 dark:border-amber-900",
      note: "Withdrawal requests awaiting settlement",
    },
    {
      label: "Paid Out",
      value: rupees(wallet.paidOut),
      icon: CheckCircle2,
      color: "text-orange-600",
      bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
      note: "Lifetime, settled withdrawals",
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <PageHeader
        title="Courier Wallet"
        description="What courier earned, what riders earned, what the platform keeps, and who still needs to be paid."
        badge={<Badge variant="info">Courier Ops</Badge>}
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

      {/* Revenue / earning / margin */}
      {overviewLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {moneyStats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              description={stat.note}
              icon={stat.icon}
              color={stat.color}
              bg={stat.bg}
            />
          ))}
        </div>
      )}

      {/* Rider wallet / withdrawal picture */}
      <div>
        <div className="mb-3 flex items-center gap-2 px-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <Info className="h-3.5 w-3.5" />
          Rider wallets pool courier and grocery earnings together — these three figures cover riders who do courier work, not courier money alone.
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {walletStats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              description={stat.note}
              icon={stat.icon}
              color={stat.color}
              bg={stat.bg}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Rider breakdown */}
        <Card
          className="overflow-hidden lg:col-span-2"
          contentClassName="p-0"
          title="Top Courier Riders"
          subtitle="By lifetime courier earning"
        >
          <div className="max-h-[480px] overflow-y-auto">
            {overviewLoading ? (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : riders.length === 0 ? (
              <EmptyState icon={Users} title="No courier riders yet" />
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {riders.map((rider) => (
                  <div key={rider.id} className="flex items-center gap-3 px-5 py-3">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        rider.isOnline ? "bg-orange-500" : "bg-slate-300 dark:bg-slate-600",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">
                        {rider.name}
                      </p>
                      <p className="text-[11px] text-slate-400">{rider.phone}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                        {rupees(rider.porterEarned)}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        balance {rupees(rider.walletBalance)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Payment ready / withdrawal history */}
        <Card className="overflow-hidden lg:col-span-3" contentClassName="p-0">
          <div className="flex flex-col gap-3 border-b border-slate-100 p-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5">
              {WITHDRAWAL_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    setStatusTab(tab.key);
                    setPage(1);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    statusTab === tab.key
                      ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <Link
              to="/admin/porter/rider-payouts"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              Full earnings history
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {withdrawalsLoading ? (
            <div className="flex h-52 items-center justify-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          ) : (withdrawals?.items || []).length === 0 ? (
            <EmptyState
              icon={Banknote}
              title={statusTab === "pending" ? "Nothing pending — riders are paid up" : "No withdrawal requests here"}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50">
                  <tr>
                    {["Rider", "Pay To", "Amount", "Status", "Date", ""].map((head) => (
                      <th
                        key={head}
                        className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500"
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {withdrawals.items.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50/60 dark:hover:opacity-90/40">
                      <td className="px-5 py-3">
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{row.rider}</p>
                        <p className="font-mono text-[11px] text-slate-400">{row.riderPhone || "—"}</p>
                      </td>
                      <td className="px-5 py-3">
                        <PayoutDestination payout={row.payout} />
                      </td>
                      <td className="px-5 py-3 font-mono text-xs font-bold text-slate-900 dark:text-white">
                        {rupees(row.amount)}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={row.status === "Settled" ? "success" : "warning"}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-[11px] text-slate-500">
                        {row.date
                          ? new Date(row.date).toLocaleDateString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setViewTarget(row)}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-[color:var(--primary)] hover:text-white dark:bg-slate-800 dark:text-slate-300"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            View
                          </button>
                          {row.status !== "Settled" && (
                            <button
                              onClick={() => setSettleTarget(row)}
                              className="inline-flex items-center gap-1 rounded-lg bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-700 transition hover:bg-orange-500 hover:text-white dark:bg-orange-950/40 dark:text-orange-400"
                            >
                              <Banknote className="h-3.5 w-3.5" />
                              Mark Paid
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {withdrawals?.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 dark:border-slate-800">
              <p className="text-xs text-slate-500">
                Page {withdrawals.page} of {withdrawals.totalPages} · {withdrawals.total} requests
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
                  disabled={page >= withdrawals.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 disabled:opacity-40 dark:border-slate-700"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <WithdrawalDetailModal row={viewTarget} onClose={() => setViewTarget(null)} />

      <ConfirmDialog
        isOpen={Boolean(settleTarget)}
        onCancel={() => !settling && setSettleTarget(null)}
        onConfirm={handleConfirmSettle}
        title="Mark this payment as paid?"
        message={
          settleTarget
            ? `Confirms ${rupees(settleTarget.amount)} has been paid to ${settleTarget.rider} outside the app (bank transfer, UPI, etc). This cannot be undone from here.`
            : ""
        }
        confirmLabel={settling ? "Marking..." : "Mark as Paid"}
        cancelLabel="Cancel"
        loading={settling}
        variant="primary"
      />
    </div>
  );
};

export default PorterWallet;
