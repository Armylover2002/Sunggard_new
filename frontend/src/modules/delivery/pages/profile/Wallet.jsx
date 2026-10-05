import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Wallet,
  IndianRupee,
  Clock,
  Banknote,
  ArrowUpRight,
  ArrowDownLeft,
  RotateCw,
  CreditCard,
  TrendingUp,
  Gift,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import Button from "@/shared/components/ui/Button";
import { deliveryApi } from "../../services/deliveryApi";

const formatINR = (value) =>
  Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  });

const formatTxnDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const resolveTipAmount = (txn) =>
  Number(
    txn?.meta?.tipAmount ??
      txn?.order?.paymentBreakdown?.riderTipAmount ??
      txn?.order?.pricing?.tip ??
      0,
  );

const isWithdrawal = (t) => String(t?.type || "").includes("Withdrawal");

const WalletPage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState({
    availableBalance: 0,
    pendingBalance: 0,
    cashInHand: 0,
    totalCredited: 0,
    totalDebited: 0,
  });
  const [earnings, setEarnings] = useState({
    totalEarnings: 0,
    availableBalance: 0,
    withdrawnTotal: 0,
    pendingWithdrawals: 0,
    today: 0,
    incentives: 0,
    tipsReceived: 0,
    transactions: [],
  });

  const fetchWallet = useCallback(async () => {
    try {
      setLoading(true);
      const [walletRes, earningsRes, statsRes] = await Promise.all([
        deliveryApi.getWalletSummary().catch(() => null),
        deliveryApi.getEarnings().catch(() => null),
        deliveryApi.getStats().catch(() => null),
      ]);

      if (walletRes?.data?.success && walletRes.data.result) {
        const r = walletRes.data.result;
        setWallet({
          availableBalance: Number(r.availableBalance || 0),
          pendingBalance: Number(r.pendingBalance || 0),
          cashInHand: Number(r.cashInHand || 0),
          totalCredited: Number(r.totalCredited || 0),
          totalDebited: Number(r.totalDebited || 0),
        });
      }

      if (earningsRes?.data?.success && earningsRes.data.result) {
        const r = earningsRes.data.result;
        const txns = Array.isArray(r.transactions)
          ? r.transactions
          : Array.isArray(r.recentTransactions)
            ? r.recentTransactions
            : [];
        setEarnings({
          totalEarnings: Number(r.totalEarnings || 0),
          availableBalance: Number(r.availableBalance || 0),
          withdrawnTotal: Number(r.withdrawnTotal || 0),
          pendingWithdrawals: Number(r.pendingWithdrawals || 0),
          today: Number(statsRes?.data?.result?.today || 0),
          incentives: Number(r.incentives || 0),
          tipsReceived: Number(r.tipsReceived || 0),
          transactions: txns,
        });
      } else if (statsRes?.data?.success && statsRes.data.result) {
        setEarnings((prev) => ({
          ...prev,
          today: Number(statsRes.data.result.today || 0),
        }));
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load wallet");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWallet();
  }, [fetchWallet]);

  // Prefer API aggregates; fall back to local txn math for older backends.
  const balances = useMemo(() => {
    const txns = earnings.transactions || [];
    const withdrawnFromTxns = txns
      .filter((t) => isWithdrawal(t) && t.status === "Settled")
      .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
    const pendingFromTxns = txns
      .filter(
        (t) =>
          isWithdrawal(t) &&
          (t.status === "Pending" || t.status === "Processing"),
      )
      .reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);

    const withdrawn = Math.max(
      Number(earnings.withdrawnTotal || 0),
      Number(wallet.totalDebited || 0),
      withdrawnFromTxns,
    );
    const pending = Math.max(
      Number(earnings.pendingWithdrawals || 0),
      pendingFromTxns,
    );
    const availableFromApi = Number(earnings.availableBalance);
    const available =
      Number.isFinite(availableFromApi) && earnings.totalEarnings >= 0
        ? Math.max(0, availableFromApi)
        : Math.max(0, Number(earnings.totalEarnings || 0) - withdrawn - pending);

    return {
      available,
      pending,
      withdrawn,
      cashInHand: Number(wallet.cashInHand || 0),
    };
  }, [earnings, wallet]);

  const earningTxns = earnings.transactions
    .filter(
      (t) =>
        t.type === "Delivery Earning" ||
        t.type === "Incentive" ||
        t.type === "Bonus",
    )
    .slice(0, 8);

  const quickActions = [
    {
      label: "Withdraw",
      sub: "Request payout",
      icon: IndianRupee,
      path: "/delivery/profile/withdrawals",
      color: "text-emerald-600 bg-emerald-50",
    },
    {
      label: "Courier Cash",
      sub: "Deposit to admin",
      icon: Banknote,
      path: "/delivery/porter-cash",
      color: "text-orange-600 bg-orange-50",
    },
    {
      label: "Bank Account",
      sub: "Payout account",
      icon: CreditCard,
      path: "/delivery/profile/bank-account",
      color: "text-sky-600 bg-sky-50",
    },
    {
      label: "Full Earnings",
      sub: "Charts & history",
      icon: TrendingUp,
      path: "/delivery/earnings",
      color: "text-violet-600 bg-violet-50",
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white shadow-sm sticky top-0 z-10">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center">
            <button
              onClick={() => navigate(-1)}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors mr-2"
              type="button"
            >
              <ArrowLeft size={20} className="text-gray-600" />
            </button>
            <h1 className="text-lg font-bold text-gray-900">Wallet</h1>
          </div>
          <button
            type="button"
            onClick={fetchWallet}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors text-gray-500"
            aria-label="Refresh wallet"
          >
            <RotateCw size={18} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-5">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl p-6 text-white shadow-xl relative overflow-hidden"
          style={{
            background:
              "linear-gradient(to bottom right, var(--brand-900), var(--brand-600))",
          }}
        >
          <div className="absolute top-0 right-0 w-36 h-36 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-xl bg-white/15">
                <TrendingUp size={18} className="text-white" />
              </div>
              <p className="text-xs font-bold uppercase tracking-wider text-white/80">
                Total Earnings
              </p>
            </div>
            <h2 className="text-4xl font-extrabold tracking-tight">
              {loading ? "…" : `₹${formatINR(earnings.totalEarnings)}`}
            </h2>
            <p className="text-sm text-white/75 mt-2">
              Today ₹{formatINR(earnings.today)} · Withdrawable ₹
              {formatINR(balances.available)}
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="bg-white/10 border border-white/10 rounded-xl p-3 backdrop-blur-sm">
                <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1 flex items-center gap-1">
                  <Gift size={12} /> Incentives
                </p>
                <p className="text-lg font-bold">
                  ₹{formatINR(earnings.incentives)}
                </p>
              </div>
              <div className="bg-white/10 border border-white/10 rounded-xl p-3 backdrop-blur-sm">
                <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1 flex items-center gap-1">
                  <Sparkles size={12} /> Tips
                </p>
                <p className="text-lg font-bold">
                  ₹{formatINR(earnings.tipsReceived)}
                </p>
              </div>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 text-emerald-600 mb-2">
              <Wallet size={16} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                Available
              </span>
            </div>
            <p className="text-xl font-black text-gray-900">
              ₹{formatINR(balances.available)}
            </p>
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 text-amber-600 mb-2">
              <Banknote size={16} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                Cash in Hand
              </span>
            </div>
            <p className="text-xl font-black text-gray-900">
              ₹{formatINR(balances.cashInHand)}
            </p>
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 text-sky-600 mb-2">
              <Clock size={16} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                Pending
              </span>
            </div>
            <p className="text-xl font-black text-gray-900">
              ₹{formatINR(balances.pending)}
            </p>
          </div>
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 text-rose-600 mb-2">
              <ArrowUpRight size={16} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                Withdrawn
              </span>
            </div>
            <p className="text-xl font-black text-gray-900">
              ₹{formatINR(balances.withdrawn)}
            </p>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between px-1 mb-3">
            <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              Recent Earnings
            </h3>
            <button
              type="button"
              onClick={() => navigate("/delivery/earnings")}
              className="text-[10px] font-bold text-primary uppercase"
            >
              See all
            </button>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden divide-y divide-gray-50">
            {loading ? (
              <div className="p-6 text-center text-sm text-gray-400">Loading…</div>
            ) : earningTxns.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">
                No earnings yet. Complete deliveries to see credits here.
              </div>
            ) : (
              earningTxns.map((txn, idx) => {
                const tip = resolveTipAmount(txn);
                const title =
                  txn.type === "Incentive" || txn.type === "Bonus"
                    ? txn.type
                    : txn?.meta?.kind === "parcel"
                      ? "Courier Earning"
                      : "Delivery Earning";
                const orderRef =
                  txn?.order?.orderId ||
                  txn?.meta?.parcelId ||
                  txn?.reference ||
                  "";
                return (
                  <div
                    key={txn._id || txn.reference || idx}
                    className="flex items-center justify-between gap-3 p-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                        <ArrowDownLeft size={18} />
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-gray-900 truncate">
                          {title}
                        </p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {formatTxnDate(txn.createdAt || txn.date)}
                          {orderRef ? ` · ${String(orderRef).slice(-8)}` : ""}
                          {tip > 0 ? ` · Tip ₹${formatINR(tip)}` : ""}
                        </p>
                      </div>
                    </div>
                    <p className="font-black text-emerald-600 shrink-0">
                      +₹{formatINR(txn.amount)}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div>
          <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 px-1">
            Quick Actions
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {quickActions.map((action) => (
              <button
                key={action.path}
                type="button"
                onClick={() => navigate(action.path)}
                className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 text-left hover:shadow-md transition-all active:scale-[0.98]"
              >
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${action.color}`}
                >
                  <action.icon size={18} />
                </div>
                <p className="font-bold text-gray-900 text-sm">{action.label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{action.sub}</p>
              </button>
            ))}
          </div>
        </div>

        <Button
          className="w-full py-6 rounded-2xl font-bold"
          onClick={() => navigate("/delivery/profile/withdrawals")}
          disabled={balances.available <= 0}
        >
          <IndianRupee size={18} className="mr-2" />
          Request Withdrawal
        </Button>
      </div>
    </div>
  );
};

export default WalletPage;
