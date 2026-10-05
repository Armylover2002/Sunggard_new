import React, { useCallback, useEffect, useState } from "react";
import {
    Banknote,
    Users,
    Loader2,
    AlertTriangle,
    Receipt,
    RotateCw,
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
 * What porter has paid its riders.
 *
 * Deliberately the earning side, not withdrawals. A rider's balance pools
 * grocery and parcel work and they withdraw against the pool, so a
 * "porter withdrawal" is not a thing that exists — the general Money Requests
 * screen remains the one place withdrawals are approved. Every row here is
 * traceable to a single parcel.
 */

const FILTERS = [
    { key: "", label: "All" },
    { key: "parcel", label: "Outstation" },
];

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

const PorterRiderPayouts = () => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [kind, setKind] = useState("");
    const [page, setPage] = useState(1);

    const fetchPayouts = useCallback(
        async (isManual = false) => {
            if (isManual) setRefreshing(true);
            try {
                const res = await adminPorterApi.getRiderPayouts({
                    page,
                    limit: 25,
                    ...(kind ? { kind } : {}),
                });
                if (res.data.success) setData(res.data.result);
            } catch (error) {
                console.error("Courier payouts error:", error);
                toast.error(
                    error?.response?.data?.message || "Couldn't load courier payouts",
                );
            } finally {
                setLoading(false);
                if (isManual) setRefreshing(false);
            }
        },
        [kind, page],
    );

    useEffect(() => {
        fetchPayouts();
    }, [fetchPayouts]);

    const summary = data?.summary || {};
    const modules = data?.modules || [];
    const items = data?.items || [];

    const stats = [
        {
            label: "Paid to riders",
            value: rupees(summary.totalPaid),
            icon: Banknote,
            color: "text-orange-600",
            bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
            note: `${summary.entries || 0} settlements`,
        },
        {
            label: "Riders paid",
            value: Number(summary.riders || 0).toLocaleString("en-IN"),
            icon: Users,
            color: "text-orange-600",
            bg: "bg-orange-500/10 border border-orange-200 dark:border-orange-900",
            note: "With at least one courier job",
        },
        {
            label: "Held back",
            value: rupees(summary.withheldAmount),
            icon: AlertTriangle,
            color: "text-amber-600",
            bg: "bg-amber-500/10 border border-amber-200 dark:border-amber-900",
            note: `${summary.withheldCount || 0} awaiting review`,
        },
    ];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Rider Payouts"
                description="Earnings from courier jobs only. Withdrawals stay under Money Requests — riders draw against one balance shared with grocery work, so a withdrawal can't be split by service."
                icon={Receipt}
                actions={
                    <button
                        onClick={() => fetchPayouts(true)}
                        className="inline-flex items-center gap-2 rounded-2xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-primary/90"
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
                        color={stat.color}
                        bg={stat.bg}
                    />
                ))}
            </div>

            {modules.length > 0 && (
                <Card className="p-5">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                        By service
                    </p>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {modules.map((m) => (
                            <div
                                key={m.kind}
                                className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60"
                            >
                                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                    {m.label}
                                </p>
                                <p className="font-mono text-lg font-extrabold text-slate-900 dark:text-white">
                                    {rupees(m.amount)}
                                </p>
                                <p className="text-[11px] text-slate-400">{m.count} settlements</p>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            <Card className="p-3">
                <div className="flex flex-wrap gap-2">
                    {FILTERS.map((f) => (
                        <button
                            key={f.key || "all"}
                            onClick={() => {
                                setKind(f.key);
                                setPage(1);
                            }}
                            className={cn(
                                "rounded-xl px-4 py-2 text-xs font-bold transition",
                                kind === f.key
                                    ? "bg-primary text-white"
                                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </Card>

            <Card className="overflow-hidden p-0">
                {loading ? (
                    <div className="flex h-64 items-center justify-center">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                ) : items.length === 0 ? (
                    <EmptyState
                        icon={Banknote}
                        title="No courier settlements"
                        description="No courier settlements in this view."
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50">
                                <tr>
                                    {["Rider", "Service", "Courier", "Amount", "Status", "Date"].map(
                                        (head) => (
                                            <th
                                                key={head}
                                                className="px-5 py-3.5 text-xs font-bold uppercase tracking-wider text-slate-500"
                                            >
                                                {head}
                                            </th>
                                        ),
                                    )}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {items.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="transition-colors hover:bg-slate-50/60 dark:hover:opacity-90/40"
                                    >
                                        <td className="px-5 py-3.5">
                                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                                                {row.rider}
                                            </p>
                                            <p className="font-mono text-[11px] text-slate-400">
                                                {row.riderPhone || "—"}
                                            </p>
                                        </td>
                                        <td className="px-5 py-3.5">
                                            <Badge variant="info">
                                                {row.kindLabel}
                                            </Badge>
                                        </td>
                                        <td className="px-5 py-3.5 font-mono text-xs text-slate-500">
                                            {row.parcelRef || "—"}
                                        </td>
                                        <td className="px-5 py-3.5 font-mono text-sm font-bold text-slate-900 dark:text-white">
                                            {rupees(row.amount)}
                                        </td>
                                        <td className="px-5 py-3.5">
                                            <Badge variant={row.status === "Settled" ? "success" : "gray"}>
                                                {row.status}
                                            </Badge>
                                        </td>
                                        <td className="px-5 py-3.5 text-xs text-slate-500">
                                            {row.date
                                                ? new Date(row.date).toLocaleDateString("en-IN", {
                                                      day: "numeric",
                                                      month: "short",
                                                      year: "numeric",
                                                  })
                                                : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {data?.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3.5 dark:border-slate-800">
                        <p className="text-xs text-slate-500">
                            Page {data.page} of {data.totalPages} · {data.total} settlements
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
                                disabled={page >= data.totalPages}
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
    );
};

export default PorterRiderPayouts;
