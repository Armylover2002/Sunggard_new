import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    Package,
    Truck,
    Wallet,
    TrendingUp,
    Loader2,
    RotateCw,
    ArrowRight,
    Layers,
    Route,
    Boxes,
    Users,
    ShieldCheck,
    Star,
    Banknote,
    CalendarCheck,
    XCircle,
    CircleDollarSign,
    MapPin,
    PieChart as PieChartIcon,
    Bike,
} from "lucide-react";
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
} from "recharts";
import { toast } from "sonner";
import Card from "@shared/components/ui/Card";
import StatusBadge from "@shared/components/ui/StatusBadge";
import StatCard from "@shared/components/ui/StatCard";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import RiderRatingsModal from "../../components/RiderRatingsModal";
import { cn } from "@/lib/utils";

const RANGES = [
    { label: "7D", days: 7 },
    { label: "14D", days: 14 },
    { label: "30D", days: 30 },
];

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

/** "2026-09-08" → "8 Sep". Kept local so the axis never shows an ISO string. */
const shortDate = (iso) => {
    const date = new Date(`${iso}T00:00:00Z`);
    return date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
};

const tooltipStyle = {
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    borderRadius: "16px",
    color: "#FFFFFF",
    fontSize: "13px",
    fontWeight: 700,
    padding: "10px 14px",
};

const STATUS_DONUT = [
    { key: "completed", label: "Completed", color: "#10B981" },
    { key: "ongoing", label: "Ongoing", color: "#2563EB" },
    { key: "pending", label: "Pending", color: "#F59E0B" },
    { key: "cancelled", label: "Cancelled", color: "#EF4444" },
];

const PAYMENT_TABS = [
    { key: "all", label: "All" },
    { key: "cod", label: "COD" },
    { key: "online", label: "Online" },
    { key: "wallet", label: "Wallet" },
];

const FLEET_DONUT = [
    { key: "onlineFree", label: "Online", color: "#10B981" },
    { key: "busy", label: "Busy", color: "#2563EB" },
    { key: "offline", label: "Offline", color: "#94A3B8" },
];

const PorterDashboard = () => {
    const navigate = useNavigate();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [days, setDays] = useState(14);
    const [payment, setPayment] = useState("all");
    const [ratingsRider, setRatingsRider] = useState(null);

    const fetchDashboard = useCallback(
        async (isManual = false) => {
            if (isManual) setRefreshing(true);
            try {
                const res = await adminPorterApi.getPorterDashboard({ days, payment });
                if (res.data.success) setData(res.data.result);
            } catch (error) {
                console.error("Courier dashboard error:", error);
                toast.error(
                    error?.response?.data?.message || "Failed to load courier data",
                );
            } finally {
                setLoading(false);
                if (isManual) setRefreshing(false);
            }
        },
        [days, payment],
    );

    useEffect(() => {
        fetchDashboard();
    }, [fetchDashboard]);

    if (loading) {
        return (
            <div className="flex h-[70vh] flex-col items-center justify-center gap-4">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm font-bold uppercase tracking-wider text-slate-400">
                    Loading courier desk…
                </p>
            </div>
        );
    }

    const overview = data?.overview || {};
    const attention = data?.needsAttention || {};
    const trend = data?.trend || [];
    const recent = data?.recent || [];
    const courierCompanies = data?.courierCompanies || [];
    const marginBreakdown = data?.marginBreakdown || null;
    const statusOverview = data?.statusOverview || {};
    const topAreas = data?.topAreas || [];
    const paymentSummary = data?.paymentSummary || {};
    const drivers = data?.drivers || [];
    const refunds = data?.refunds || {};

    const trendChart = trend.map((row) => ({ ...row, label: shortDate(row.date) }));

    const statusTotal = STATUS_DONUT.reduce((sum, s) => sum + (statusOverview[s.key] || 0), 0);
    const statusChart = STATUS_DONUT.map((s) => ({ ...s, value: statusOverview[s.key] || 0 }));

    const fleet = overview.fleet || {};
    const fleetOnlineFree = Math.max((fleet.online || 0) - (fleet.busy || 0), 0);
    const fleetChart = [
        { ...FLEET_DONUT[0], value: fleetOnlineFree },
        { ...FLEET_DONUT[1], value: fleet.busy || 0 },
        { ...FLEET_DONUT[2], value: fleet.offline || 0 },
    ];

    const kpis = [
        {
            label: "Total Couriers",
            value: Number(overview.totalParcels || 0).toLocaleString("en-IN"),
            icon: Package,
            tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
            note: `${overview.activeParcels || 0} still in flight`,
        },
        {
            label: "Today's Couriers",
            value: Number(overview.todayParcels || 0).toLocaleString("en-IN"),
            icon: CalendarCheck,
            tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
            note: "Booked since midnight",
        },
        {
            label: "Active Deliveries",
            value: Number(overview.activeParcels || 0).toLocaleString("en-IN"),
            icon: Bike,
            tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
            note: "Real-time in-transit count",
        },
        {
            label: "Delivered",
            value: Number(overview.deliveredParcels || 0).toLocaleString("en-IN"),
            icon: Truck,
            tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
            note: "Completed bookings",
        },
        {
            label: "Cancelled",
            value: Number(overview.cancelledParcels || 0).toLocaleString("en-IN"),
            icon: XCircle,
            tint: "bg-red-500/10 text-red-600 border-red-200 dark:border-red-900",
            note: "Cancelled + returned",
        },
        {
            label: "Revenue",
            value: rupees(overview.revenue),
            icon: Wallet,
            tint: "bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-900",
            note: `${rupees(overview.riderEarned)} earned by riders · billed on delivered bookings`,
        },
        {
            label: "Admin Earning",
            value: rupees(overview.adminEarning ?? overview.margin),
            icon: TrendingUp,
            tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
            note: overview.cashWithRiders > 0
                ? `Counted once cash reaches admin · ${rupees(overview.pendingEarning)} more pending`
                : "Cash received, after rider earning — see breakdown below",
        },
        {
            label: "Paid To Riders",
            value: rupees(overview.riderPayout),
            icon: CircleDollarSign,
            tint: "bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-200 dark:border-fuchsia-900",
            note: `${rupees(overview.riderOwed)} earned, not withdrawn yet`,
        },
    ];

    return (
        <div className="space-y-6 md:space-y-8">
            {/* Header */}
            <div className="relative overflow-hidden rounded-3xl border border-slate-700/60 bg-gradient-to-r from-slate-900 via-slate-800 to-[#111827] p-6 text-white shadow-2xl md:p-9">
                <div className="pointer-events-none absolute -mr-20 -mt-20 right-0 top-0 h-96 w-96 rounded-full bg-primary/25 blur-3xl" />

                <div className="relative z-10 flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
                    <div className="space-y-2.5">
                        <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-bold backdrop-blur-md">
                            <Boxes className="h-4 w-4 text-primary" />
                            <span>Courier Desk</span>
                        </div>
                        <h1 className="text-2xl font-black tracking-tight text-white md:text-4xl">
                            Courier operations
                        </h1>
                        <p className="max-w-xl text-sm text-slate-300 md:text-base">
                            Courier bookings for the last {days} days.
                        </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1.5 rounded-2xl bg-white/10 p-1.5 backdrop-blur-sm">
                            {RANGES.map((range) => (
                                <button
                                    key={range.days}
                                    onClick={() => setDays(range.days)}
                                    className={cn(
                                        "rounded-xl px-3.5 py-1.5 text-xs font-bold uppercase transition",
                                        days === range.days
                                            ? "bg-white text-slate-900"
                                            : "text-slate-300 hover:text-white",
                                    )}
                                >
                                    {range.label}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => navigate("/admin/porter/zones")}
                            className="flex items-center gap-2.5 rounded-2xl border border-white/15 bg-white/10 px-4.5 py-3 text-sm font-bold text-white backdrop-blur-sm transition hover:bg-white/20"
                        >
                            <Layers className="h-4.5 w-4.5" />
                            <span>Zones ({overview.zones?.active ?? 0})</span>
                        </button>
                        <button
                            onClick={() => fetchDashboard(true)}
                            className="flex items-center gap-2.5 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white shadow-lg shadow-primary/30 transition hover:bg-primary/90"
                        >
                            <RotateCw className={cn("h-4.5 w-4.5", refreshing && "animate-spin")} />
                            <span>Refresh</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Payment filter: All / COD / Online */}
            <div className="space-y-4">
                <div className="inline-flex items-center gap-1.5 rounded-2xl bg-slate-100 p-1.5 dark:bg-slate-800">
                    {PAYMENT_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => setPayment(tab.key)}
                            className={cn(
                                "rounded-xl px-5 py-2 text-xs font-bold uppercase transition",
                                payment === tab.key
                                    ? "bg-primary text-white shadow"
                                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white",
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    {[
                        { key: "all", label: "Received (all)", note: "COD deposited + online + wallet" },
                        { key: "cod", label: "COD received", note: "Deposited by riders" },
                        { key: "online", label: "Online received", note: "UPI / card" },
                        { key: "wallet", label: "Wallet received", note: "Paid from customer wallet" },
                    ].map((card) => {
                        const row = paymentSummary[card.key] || {};
                        return (
                            <StatCard
                                key={card.key}
                                label={card.label}
                                value={rupees(row.amount)}
                                description={`${card.note}${row.withRiders > 0 ? ` · ${rupees(row.withRiders)} still with riders` : ""} · ${row.delivered || 0}/${row.bookings || 0} delivered`}
                                icon={card.key === "cod" ? Banknote : card.key === "online" ? CircleDollarSign : Wallet}
                                color="text-orange-600"
                                bg="bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900"
                            />
                        );
                    })}
                    <StatCard
                        label="Pending Admin Earning"
                        value={rupees(overview.pendingEarning)}
                        description={
                            overview.cashWithRiders > 0
                                ? `${rupees(overview.cashWithRiders)} COD with riders · moves to Admin Earning once deposited`
                                : "Nothing pending — all cash is with admin"
                        }
                        icon={Banknote}
                        color="text-amber-600"
                        bg="bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-900"
                    />
                </div>
            </div>

            {/* Customer refunds on cancelled online bookings */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                <StatCard
                    label="Refunded To Customers"
                    value={rupees(refunds.refundedAmount)}
                    description={`${refunds.refundedCount || 0} cancelled online booking${refunds.refundedCount === 1 ? "" : "s"} refunded via gateway`}
                    icon={CircleDollarSign}
                    color="text-emerald-600"
                    bg="bg-emerald-500/10 text-emerald-600 border-emerald-200 dark:border-emerald-900"
                />
                <StatCard
                    label="Refund Pending"
                    value={rupees(refunds.pendingAmount)}
                    description={`${refunds.pendingCount || 0} paid & cancelled, refund not sent yet`}
                    icon={Banknote}
                    color="text-amber-600"
                    bg="bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-900"
                />
                <StatCard
                    label="Refund Failed"
                    value={rupees(refunds.failedAmount)}
                    description={`${refunds.failedCount || 0} refund${refunds.failedCount === 1 ? "" : "s"} the gateway refused — needs attention`}
                    icon={XCircle}
                    color="text-red-600"
                    bg="bg-red-500/10 text-red-600 border-red-200 dark:border-red-900"
                />
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4 md:gap-6">
                {kpis.map((kpi) => (
                    <StatCard
                        key={kpi.label}
                        label={kpi.label}
                        value={kpi.value}
                        description={kpi.note}
                        icon={kpi.icon}
                        color={kpi.tint.split(" ")[1]}
                        bg={kpi.tint}
                    />
                ))}
            </div>

            {/* Fleet & quality */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 md:gap-6">
                {[
                    {
                        label: "Total Couriers",
                        value: Number(overview.fleet?.total || 0).toLocaleString("en-IN"),
                        icon: Users,
                        tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
                        note: `${overview.fleet?.online || 0} online right now`,
                    },
                    {
                        label: "Verified Riders",
                        value: Number(overview.fleet?.verified || 0).toLocaleString("en-IN"),
                        icon: ShieldCheck,
                        tint: "bg-orange-500/10 text-orange-600 border-orange-200 dark:border-orange-900",
                        note: overview.fleet?.total
                            ? `${Math.round(((overview.fleet?.verified || 0) / overview.fleet.total) * 100)}% of fleet KYC-verified`
                            : "No couriers yet",
                    },
                    {
                        label: "Customer Rating",
                        value: overview.rating?.count ? overview.rating.average.toFixed(1) : "—",
                        icon: Star,
                        tint: "bg-yellow-500/10 text-yellow-600 border-yellow-200 dark:border-yellow-900",
                        note: overview.rating?.count
                            ? `From ${overview.rating.count} review${overview.rating.count === 1 ? "" : "s"}`
                            : "No reviews yet",
                    },
                    {
                        label: "Pending Cash Deposits",
                        value: rupees(overview.cashWithRiders),
                        icon: Banknote,
                        tint: "bg-rose-500/10 text-rose-600 border-rose-200 dark:border-rose-900",
                        note: attention.cashDepositsPending
                            ? `${attention.cashDepositsPending} deposit${attention.cashDepositsPending === 1 ? "" : "s"} awaiting review`
                            : "COD cash riders hold, not deposited yet",
                    },
                ].map((kpi) => (
                    <StatCard
                        key={kpi.label}
                        label={kpi.label}
                        value={kpi.value}
                        description={kpi.note}
                        icon={kpi.icon}
                        color={kpi.tint.split(" ")[1]}
                        bg={kpi.tint}
                    />
                ))}
            </div>

            {/* Charts */}
            {/* LOCAL CITY PARCEL DISABLED — the "Module split" card that compared
                pickup vs. city bookings is removed; this chart now spans full
                width. Re-enable by restoring the card from git history. */}
            <div className="grid grid-cols-1 gap-6">
                <Card className="overflow-hidden rounded-3xl p-6 shadow-sm md:p-7">
                    <div className="border-b border-slate-100 pb-5 dark:border-slate-800">
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                            <Route className="h-5 w-5 text-primary" />
                            Bookings & revenue
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            Daily courier volume
                        </p>
                    </div>

                    <div className="h-[300px] w-full pt-6">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart
                                data={trendChart}
                                margin={{ top: 10, right: 20, left: 5, bottom: 5 }}
                            >
                                <defs>
                                    <linearGradient id="porterRevenue" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid
                                    strokeDasharray="3 3"
                                    vertical={false}
                                    stroke="#E2E8F0"
                                    opacity={0.6}
                                />
                                <XAxis
                                    dataKey="label"
                                    tickLine={false}
                                    axisLine={false}
                                    tick={{ fontSize: 12, fill: "#64748B", fontWeight: 600 }}
                                />
                                <YAxis
                                    width={60}
                                    tickLine={false}
                                    axisLine={false}
                                    tick={{ fontSize: 12, fill: "#64748B", fontWeight: 600 }}
                                    tickFormatter={(v) => (v >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`)}
                                />
                                <Tooltip
                                    contentStyle={tooltipStyle}
                                    formatter={(value) => [rupees(value), "Revenue"]}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="revenue"
                                    stroke="var(--primary)"
                                    strokeWidth={3}
                                    fill="url(#porterRevenue)"
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
            </div>

            {/* Booking status & fleet status donuts */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card className="flex flex-col rounded-3xl p-6 shadow-sm md:p-7">
                    <div>
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                            <PieChartIcon className="h-5 w-5 text-primary" />
                            Booking Status
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            Completed, ongoing, pending and cancelled courier bookings
                        </p>
                    </div>

                    <div className="relative flex h-[220px] w-full items-center justify-center my-2">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={statusChart}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={65}
                                    outerRadius={95}
                                    paddingAngle={statusTotal ? 5 : 0}
                                    dataKey="value"
                                >
                                    {statusChart.map((entry) => (
                                        <Cell key={entry.key} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip contentStyle={tooltipStyle} />
                            </PieChart>
                        </ResponsiveContainer>
                        <div className="pointer-events-none absolute flex flex-col items-center">
                            <span className="text-2xl font-black text-slate-900 dark:text-white">
                                {statusTotal.toLocaleString("en-IN")}
                            </span>
                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Total
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                        {statusChart.map((s) => (
                            <div key={s.key} className="flex items-center justify-between text-sm">
                                <span className="flex items-center gap-2">
                                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                                    <span className="font-semibold text-slate-700 dark:text-slate-200">{s.label}</span>
                                </span>
                                <span className="font-mono font-bold text-slate-900 dark:text-white">
                                    {s.value.toLocaleString("en-IN")}
                                    <span className="ml-1 text-[11px] font-medium text-slate-400">
                                        ({statusTotal ? Math.round((s.value / statusTotal) * 100) : 0}%)
                                    </span>
                                </span>
                            </div>
                        ))}
                    </div>
                </Card>

                <Card className="flex flex-col rounded-3xl p-6 shadow-sm md:p-7">
                    <div>
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                            <Users className="h-5 w-5 text-orange-600" />
                            Delivery Boy Status
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            Live fleet availability right now
                        </p>
                    </div>

                    <div className="relative flex h-[220px] w-full items-center justify-center my-2">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={fleetChart}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={65}
                                    outerRadius={95}
                                    paddingAngle={fleet.total ? 5 : 0}
                                    dataKey="value"
                                >
                                    {fleetChart.map((entry) => (
                                        <Cell key={entry.key} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip contentStyle={tooltipStyle} />
                            </PieChart>
                        </ResponsiveContainer>
                        <div className="pointer-events-none absolute flex flex-col items-center">
                            <span className="text-2xl font-black text-slate-900 dark:text-white">
                                {Number(fleet.total || 0).toLocaleString("en-IN")}
                            </span>
                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Total
                            </span>
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                        {fleetChart.map((s) => (
                            <div key={s.key} className="text-center">
                                <p className="flex items-center justify-center gap-1.5 font-mono text-lg font-extrabold text-slate-900 dark:text-white">
                                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                                    {s.value.toLocaleString("en-IN")}
                                </p>
                                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                    {s.label} {fleet.total ? `(${Math.round((s.value / fleet.total) * 100)}%)` : ""}
                                </p>
                            </div>
                        ))}
                    </div>
                </Card>
            </div>

            {/* Top areas */}
            <div className="grid grid-cols-1 gap-6">
                <Card className="rounded-3xl p-6 shadow-sm md:p-7">
                    <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                        <MapPin className="h-5 w-5 text-primary" />
                        Top Areas by Bookings
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 md:text-sm">Zones ranked by couriers in this window</p>

                    <div className="mt-5 space-y-4">
                        {topAreas.length === 0 ? (
                            <p className="py-6 text-center text-sm text-slate-400">
                                No zone-tagged bookings yet.
                            </p>
                        ) : (
                            (() => {
                                const maxCount = Math.max(...topAreas.map((z) => z.count), 1);
                                return topAreas.map((zone) => (
                                    <div key={zone.zoneId}>
                                        <div className="mb-1.5 flex items-center justify-between text-sm">
                                            <span className="truncate font-semibold text-slate-700 dark:text-slate-200">
                                                {zone.name}
                                                {zone.city ? (
                                                    <span className="ml-1 text-xs font-normal text-slate-400">
                                                        · {zone.city}
                                                    </span>
                                                ) : null}
                                            </span>
                                            <span className="font-mono font-bold text-slate-900 dark:text-white">
                                                {zone.count}
                                            </span>
                                        </div>
                                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                                            <div
                                                className="h-full rounded-full bg-primary"
                                                style={{ width: `${Math.max((zone.count / maxCount) * 100, 4)}%` }}
                                            />
                                        </div>
                                    </div>
                                ));
                            })()
                        )}
                    </div>
                </Card>
            </div>

            {/* Driver list */}
            <Card className="overflow-hidden rounded-3xl p-0 shadow-sm">
                <div className="border-b border-slate-100 p-6 dark:border-slate-800">
                    <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white">
                        <Users className="h-5 w-5 text-primary" />
                        Driver list
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 md:text-sm">
                        Delivered, accepted and rejected requests per driver in this window
                    </p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50">
                            <tr>
                                {["Driver", "Status", "Rating", "Accepted", "Delivered", "Rejected"].map((head) => (
                                    <th
                                        key={head}
                                        className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500"
                                    >
                                        {head}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {drivers.length === 0 ? (
                                <tr>
                                    <td colSpan={6}>
                                        <EmptyState
                                            icon={Users}
                                            title="No drivers yet"
                                            description="Courier drivers will appear here once they sign up."
                                        />
                                    </td>
                                </tr>
                            ) : (
                                drivers.map((d) => (
                                    <tr key={d.id} className="transition-colors hover:bg-slate-50/60 dark:hover:opacity-90/40">
                                        <td className="px-6 py-4">
                                            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{d.name}</p>
                                            <p className="text-xs text-slate-400">{d.phone}</p>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span
                                                className={cn(
                                                    "rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wide",
                                                    !d.isOnline
                                                        ? "bg-slate-100 text-slate-500"
                                                        : d.isBusy
                                                            ? "bg-blue-50 text-blue-700"
                                                            : "bg-emerald-50 text-emerald-700",
                                                )}
                                            >
                                                {!d.isOnline ? "Offline" : d.isBusy ? "Busy" : "Online"}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <button
                                                type="button"
                                                onClick={() => setRatingsRider(d)}
                                                title="See ratings and customer feedback"
                                                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-bold text-slate-900 transition hover:bg-amber-50 dark:text-white">
                                                <span className="text-amber-500">★</span>
                                                {d.ratingCount > 0 ? (
                                                    <>
                                                        {Number(d.rating).toFixed(1)}
                                                        <span className="text-xs font-semibold text-slate-400">({d.ratingCount})</span>
                                                    </>
                                                ) : (
                                                    <span className="text-xs font-semibold text-slate-400">No ratings</span>
                                                )}
                                            </button>
                                        </td>
                                        <td className="px-6 py-4 font-mono text-sm font-bold text-slate-900 dark:text-white">{d.accepted}</td>
                                        <td className="px-6 py-4 font-mono text-sm font-bold text-emerald-600">{d.delivered}</td>
                                        <td className="px-6 py-4 font-mono text-sm font-bold text-rose-600">{d.rejected}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>

            <RiderRatingsModal rider={ratingsRider} onClose={() => setRatingsRider(null)} />

            {/* Recent parcels */}
            <Card className="overflow-hidden rounded-3xl p-0 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-100 p-6 dark:border-slate-800">
                    <div>
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white">
                            <Package className="h-5 w-5 text-primary" />
                            Latest couriers
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            Newest bookings
                        </p>
                    </div>
                    {/* LOCAL CITY PARCEL DISABLED — /admin/city-parcels route is commented out */}
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50">
                            <tr>
                                {["Module", "Customer", "Rider", "Fare", "Status"].map((head) => (
                                    <th
                                        key={head}
                                        className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500"
                                    >
                                        {head}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {recent.length === 0 ? (
                                <tr>
                                    <td colSpan={5}>
                                        <EmptyState
                                            icon={Package}
                                            title="No couriers booked in this window"
                                            description="Try a wider date range or check back later."
                                        />
                                    </td>
                                </tr>
                            ) : (
                                recent.map((row) => (
                                    <tr
                                        key={`${row.source}-${row.id}`}
                                        className="transition-colors hover:bg-slate-50/60 dark:hover:opacity-90/40"
                                    >
                                        <td className="px-6 py-4">
                                            <span
                                                className={cn(
                                                    "rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wide",
                                                    row.source === "city"
                                                        ? "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                                                        : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
                                                )}
                                            >
                                                {row.source === "city" ? "City" : "Pickup"}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-sm font-medium text-slate-700 dark:text-slate-200">
                                            {row.customer}
                                        </td>
                                        <td className="px-6 py-4 text-sm text-slate-500">
                                            {row.rider || <span className="text-slate-300">Unassigned</span>}
                                        </td>
                                        <td className="px-6 py-4 font-mono text-sm font-bold text-slate-900 dark:text-white">
                                            {rupees(row.fare)}
                                        </td>
                                        <td className="px-6 py-4">
                                            <StatusBadge status={row.status} />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>

            {marginBreakdown && (
                <Card className="overflow-hidden rounded-3xl p-6 shadow-sm md:p-7">
                    <div className="border-b border-slate-100 pb-5 dark:border-slate-800">
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                            <TrendingUp className="h-5 w-5 text-primary" />
                            Admin earning breakdown
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            Delivered bookings whose cash has reached admin (online, or COD deposited by the rider).
                        </p>
                    </div>
                    <div className="divide-y divide-slate-100 pt-2 dark:divide-slate-800">
                        {[
                            { label: "Delivery charge", value: marginBreakdown.deliveryCharge },
                            { label: "Weight charge", value: marginBreakdown.weightCharge },
                            { label: "Express charge", value: marginBreakdown.expressCharge },
                            { label: "Courier company charge", value: marginBreakdown.courierCompanyCharge },
                            {
                                label: "GST collected",
                                value: marginBreakdown.gstCollected,
                                note: "government's tax, not counted",
                            },
                            { label: "Rider earning", value: -marginBreakdown.riderEarning, negative: true },
                        ].map((row) => (
                            <div key={row.label} className="flex items-center justify-between py-2.5">
                                <div>
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{row.label}</p>
                                    {row.note && (
                                        <p className="text-[10px] text-slate-400 font-medium">{row.note}</p>
                                    )}
                                </div>
                                <p
                                    className={cn(
                                        "font-mono text-sm font-black",
                                        row.negative ? "text-rose-600" : "text-slate-900 dark:text-white",
                                    )}
                                >
                                    {row.negative ? "− " : ""}
                                    {rupees(Math.abs(row.value))}
                                </p>
                            </div>
                        ))}
                        <div className="flex items-center justify-between pt-3">
                            <p className="text-sm font-black text-slate-900 dark:text-white">Admin earning</p>
                            <p className="font-mono text-base font-black text-emerald-700">
                                {rupees(marginBreakdown.adminEarning)}
                            </p>
                        </div>
                        {marginBreakdown.pending?.cashWithRiders > 0 && (
                            <div className="mt-3 flex items-center justify-between rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
                                <div>
                                    <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                                        Pending — COD cash still with riders
                                    </p>
                                    <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80">
                                        {rupees(marginBreakdown.pending.cashWithRiders)} collected, not deposited yet. Becomes earning once admin approves the deposit.
                                    </p>
                                </div>
                                <p className="font-mono text-sm font-black text-amber-800 dark:text-amber-300">
                                    {rupees(marginBreakdown.pending.earning)}
                                </p>
                            </div>
                        )}
                    </div>
                </Card>
            )}

            <Card className="overflow-hidden rounded-3xl shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-100 p-6 dark:border-slate-800">
                    <div>
                        <h3 className="flex items-center gap-2.5 text-lg font-extrabold text-slate-900 dark:text-white md:text-xl">
                            <Truck className="h-5 w-5 text-primary" />
                            Courier company charges
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 md:text-sm">
                            What each courier company was paid, this window — delivered bookings only.
                        </p>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="border-b border-slate-100 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50">
                            <tr>
                                {["Courier company", "Bookings", "Delivered", "Charge paid"].map((head) => (
                                    <th
                                        key={head}
                                        className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500"
                                    >
                                        {head}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {courierCompanies.length === 0 ? (
                                <tr>
                                    <td colSpan={4}>
                                        <EmptyState
                                            icon={Truck}
                                            title="No courier company charges in this window"
                                            description="Try a wider date range or check back later."
                                        />
                                    </td>
                                </tr>
                            ) : (
                                courierCompanies.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="transition-colors hover:bg-slate-50/60 dark:hover:opacity-90/40"
                                    >
                                        <td className="px-6 py-4 text-sm font-bold text-slate-700 dark:text-slate-200">
                                            {row.name}
                                        </td>
                                        <td className="px-6 py-4 text-sm text-slate-500">{row.bookings}</td>
                                        <td className="px-6 py-4 text-sm text-slate-500">{row.delivered}</td>
                                        <td className="px-6 py-4 font-mono text-sm font-bold text-slate-900 dark:text-white">
                                            {rupees(row.charge)}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
};

export default PorterDashboard;
