import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Pagination from '@shared/components/ui/Pagination';
import { adminApi } from '../services/adminApi';
import { adminPorterApi } from '../services/api/porterApi';
import { toast } from 'sonner';
import Card from '@shared/components/ui/Card';
import Badge from '@shared/components/ui/Badge';
import Modal from '@shared/components/ui/Modal';
import {
    CircleDollarSign,
    Search,
    Truck,
    Clock,
    AlertTriangle,
    History,
    Wallet,
    Settings2,
    ShieldCheck,
    Ban,
    Gauge,
    RotateCw,
    Pencil,
    Package,
    MapPin,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

/**
 * Rider COD cash: how much each rider is allowed to hold, how much they are
 * holding, and what happens when they reach the limit.
 *
 * This screen previously showed a limit column that was decoration. The
 * backing aggregation read `{ $ifNull: ["$limit", 5000] }` from the rider
 * collection, and `limit` has never been a field on that model — so every
 * rider displayed exactly ₹5,000, nothing could change it, and nothing
 * enforced it. The "Over-Limit" stat counted riders against a number that did
 * not exist.
 *
 * The limit is now real and it has teeth: a rider who reaches it stops being
 * offered work, local and outstation alike, until they deposit the cash and an
 * admin approves the deposit. This screen is where the limits are set and
 * where the fleet's exposure is read.
 */

/** Mongo's 24-char hex id isn't readable — the last 6 is enough to tell riders apart. */
const shortRiderId = (id) => `RD-${String(id || '').slice(-6).toUpperCase()}`;

const rupees = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;

/** Colour by how close the rider is to their ceiling, not by an absolute figure. */
const statusTone = {
    safe: { bar: 'bg-brand-500', dot: 'bg-brand-500', badge: 'success', label: 'Safe' },
    warning: { bar: 'bg-amber-500', dot: 'bg-amber-500', badge: 'warning', label: 'Near limit' },
    blocked: { bar: 'bg-rose-500', dot: 'bg-rose-500', badge: 'danger', label: 'Blocked' },
};

const CashCollection = () => {
    const [searchTerm, setSearchTerm] = useState('');
    const [activeTab, setActiveTab] = useState('live_balances');
    const [selectedRider, setSelectedRider] = useState(null);

    const [riders, setRiders] = useState([]);
    const [stats, setStats] = useState(null);
    const [settings, setSettings] = useState(null);
    const [historyData, setHistoryData] = useState([]);

    const [ridersPage, setRidersPage] = useState(1);
    const [historyPage, setHistoryPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [ridersTotal, setRidersTotal] = useState(0);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsDraft, setSettingsDraft] = useState(null);
    const [limitDraft, setLimitDraft] = useState(null);
    const [isSaving, setIsSaving] = useState(false);

    /**
     * One fetch for both tabs.
     *
     * They are shown one at a time but the header stats span both, and
     * splitting the call would make the stats disagree with whichever tab was
     * last loaded.
     */
    const fetchData = useCallback(
        async (cashPage = 1, histPage = 1) => {
            try {
                setLoading(true);
                const params = { limit: pageSize };
                if (searchTerm.trim()) params.search = searchTerm.trim();

                const [overviewRes, historyRes] = await Promise.all([
                    adminPorterApi.getCashOverview({ ...params, page: cashPage }),
                    adminApi.getCashSettlementHistory({ ...params, page: histPage }),
                ]);

                const overview = overviewRes.data?.result || {};
                setRiders(Array.isArray(overview.items) ? overview.items : []);
                setStats(overview.stats || null);
                setSettings(overview.settings || null);
                setRidersTotal(overview.total ?? 0);
                setRidersPage(overview.page ?? cashPage);

                const historyPayload = historyRes.data?.result || {};
                const rows = Array.isArray(historyPayload.items) ? historyPayload.items : [];
                setHistoryData(rows);
                setHistoryTotal(historyPayload.total ?? rows.length);
                setHistoryPage(historyPayload.page ?? histPage);
            } catch (error) {
                console.error('Failed to load rider cash data:', error);
                toast.error(error.response?.data?.message || 'Could not load rider cash data');
            } finally {
                setLoading(false);
            }
        },
        [pageSize, searchTerm],
    );

    // Debounced so typing a rider's name does not fire a request per keystroke.
    useEffect(() => {
        const timer = setTimeout(() => fetchData(1, 1), 400);
        return () => clearTimeout(timer);
    }, [fetchData]);

    const fetchRidersPage = (p) => fetchData(p, historyPage);
    const fetchHistoryPage = (p) => fetchData(ridersPage, p);

    /* ---------------------------------------------------------------------
       Fleet-wide settings
       ------------------------------------------------------------------- */

    const openSettings = () => {
        setSettingsDraft({
            enforceCashLimit: Boolean(settings?.enforceCashLimit),
            globalCashLimit: settings?.globalCashLimit ?? 5000,
            warnAtPercent: settings?.warnAtPercent ?? 80,
            requireApprovalToResume: settings?.requireApprovalToResume !== false,
        });
        setIsSettingsOpen(true);
    };

    const saveSettings = async () => {
        try {
            setIsSaving(true);
            const { data } = await adminPorterApi.updateCashSettings({
                enforceCashLimit: settingsDraft.enforceCashLimit,
                globalCashLimit: Number(settingsDraft.globalCashLimit),
                warnAtPercent: Number(settingsDraft.warnAtPercent),
                requireApprovalToResume: settingsDraft.requireApprovalToResume,
            });
            setSettings(data?.result || settingsDraft);
            setIsSettingsOpen(false);
            toast.success('Cash policy updated');
            fetchData(ridersPage, historyPage);
        } catch (error) {
            toast.error(error.response?.data?.message || 'Could not save the cash policy');
        } finally {
            setIsSaving(false);
        }
    };

    /* ---------------------------------------------------------------------
       Per-rider override
       ------------------------------------------------------------------- */

    const openLimitEditor = (rider) => {
        setLimitDraft({
            rider,
            // Empty means "follow the global limit". Deliberately distinct from
            // "0", which is a real limit meaning this rider carries no cash.
            value: rider.riderLimitOverride == null ? '' : String(rider.riderLimitOverride),
        });
    };

    const saveRiderLimit = async (clear = false) => {
        try {
            setIsSaving(true);
            const value = clear || String(limitDraft.value).trim() === ''
                ? null
                : Number(limitDraft.value);

            if (value !== null && (!Number.isFinite(value) || value < 0)) {
                toast.error('Enter a limit of zero or more');
                return;
            }

            await adminPorterApi.setRiderCashLimit(limitDraft.rider.id, value);
            toast.success(
                value === null
                    ? `${limitDraft.rider.name} now follows the fleet limit`
                    : `${limitDraft.rider.name}'s limit is ${rupees(value)}`,
            );
            setLimitDraft(null);
            fetchData(ridersPage, historyPage);
        } catch (error) {
            toast.error(error.response?.data?.message || 'Could not update the limit');
        } finally {
            setIsSaving(false);
        }
    };

    const headerStats = useMemo(
        () => [
            {
                label: 'Cash with riders',
                value: rupees(stats?.totalInHand),
                icon: Wallet,
                bg: 'bg-brand-50',
                iconColor: 'text-brand-600',
                sub: `${rupees(stats?.totalLimit)} total allowance`,
            },
            {
                label: 'Blocked riders',
                value: stats?.blockedCount ?? 0,
                icon: Ban,
                bg: 'bg-rose-50',
                iconColor: 'text-rose-600',
                sub: settings?.enforceCashLimit ? 'Not receiving jobs' : 'Enforcement is off',
                danger: (stats?.blockedCount ?? 0) > 0,
            },
            {
                label: 'Deposits awaiting review',
                value: stats?.pendingDeposits ?? 0,
                icon: Clock,
                bg: 'bg-amber-50',
                iconColor: 'text-amber-600',
                sub: rupees(stats?.pendingDepositAmount),
            },
            {
                label: 'Average per rider',
                value: rupees(Math.round(stats?.avgBalance ?? 0)),
                icon: Gauge,
                bg: 'bg-slate-100',
                iconColor: 'text-slate-600',
            },
        ],
        [stats, settings],
    );

    const enforcementOff = settings && !settings.enforceCashLimit;

    return (
        <div className="ds-section-spacing animate-in fade-in slide-in-from-bottom-4 duration-700 pb-12 pt-6 relative z-10">
            {/* Header */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 px-1">
                <div>
                    <h1 className="ds-h1 flex items-center gap-3">
                        Cash Collection Hub
                        <div className="p-1.5 bg-brand-100 rounded-lg">
                            <CircleDollarSign className="h-5 w-5 text-brand-600" />
                        </div>
                    </h1>
                    <p className="ds-description mt-1">
                        Set how much COD cash each rider may hold. At the limit, they stop
                        receiving local and outstation jobs until a deposit is approved.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={openSettings}
                        className="flex items-center gap-2 px-5 py-3 bg-[color:var(--primary)] text-white rounded-2xl text-xs font-bold hover:opacity-90 transition-all shadow-lg active:scale-95"
                    >
                        <Settings2 className="h-4 w-4" />
                        CASH POLICY
                    </button>
                </div>
            </div>

            {/**
              * Enforcement being off is the single most consequential thing on
              * this screen, and it is invisible otherwise — every limit reads
              * as active when none of them are.
              */}
            {enforcementOff && (
                <div className="flex items-start gap-3 p-4 bg-amber-50 ring-1 ring-amber-200 rounded-2xl">
                    <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-xs font-black text-amber-900 uppercase tracking-tight">
                            Cash limits are not being enforced
                        </p>
                        <p className="text-xs text-amber-800 mt-1">
                            The limits below are recorded but no rider is blocked by them. Turn
                            enforcement on in Cash Policy to make them take effect.
                        </p>
                    </div>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {headerStats.map((stat, i) => (
                    <Card
                        key={i}
                        className="p-6 border-none shadow-sm ring-1 ring-slate-100 bg-white group hover:ring-brand-200 transition-all"
                    >
                        <div className="flex items-center justify-between mb-4">
                            <div className={cn('p-3 rounded-2xl', stat.bg)}>
                                <stat.icon className={cn('h-6 w-6', stat.iconColor)} />
                            </div>
                            {stat.danger && (
                                <Badge variant="danger" className="text-[8px] px-1.5 py-0">
                                    Action required
                                </Badge>
                            )}
                        </div>
                        <p className="ds-label mb-1 uppercase tracking-tight font-black">{stat.label}</p>
                        <h3 className="ds-stat-medium ds-stat-large">{stat.value}</h3>
                        {stat.sub && (
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tight mt-1">
                                {stat.sub}
                            </p>
                        )}
                    </Card>
                ))}
            </div>

            {/* Tabs + search */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mt-8">
                <div className="flex bg-slate-100 p-1.5 rounded-2xl w-fit">
                    <button
                        onClick={() => setActiveTab('live_balances')}
                        className={cn(
                            'flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black transition-all',
                            activeTab === 'live_balances'
                                ? 'bg-white text-slate-900 shadow-xl'
                                : 'text-slate-500 hover:text-slate-700',
                        )}
                    >
                        <Truck className="h-4 w-4" />
                        RIDER LIMITS
                    </button>
                    <button
                        onClick={() => setActiveTab('history')}
                        className={cn(
                            'flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black transition-all',
                            activeTab === 'history'
                                ? 'bg-white text-slate-900 shadow-xl'
                                : 'text-slate-500 hover:text-slate-700',
                        )}
                    >
                        <History className="h-4 w-4" />
                        SETTLEMENT LOGS
                    </button>
                </div>

                <div className="relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within:text-brand-500 transition-colors" />
                    <input
                        type="text"
                        placeholder="Find rider by name or phone..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-11 pr-4 py-2.5 bg-white ring-1 ring-slate-200 rounded-2xl text-xs font-semibold outline-none focus:ring-2 focus:ring-brand-500/10 w-64 transition-all"
                    />
                </div>
            </div>

            {/* Table */}
            <Card className="border-none shadow-2xl ring-1 ring-slate-100 overflow-hidden bg-white rounded-xl mt-6">
                <div className="overflow-x-auto">
                    {activeTab === 'live_balances' ? (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50/50 border-b border-slate-100">
                                    <th className="ds-table-header-cell pl-8 py-5">Delivery Partner</th>
                                    <th className="ds-table-header-cell">Collected vs limit</th>
                                    <th className="ds-table-header-cell text-right">Remaining</th>
                                    <th className="ds-table-header-cell text-center">Status</th>
                                    <th className="ds-table-header-cell text-right pr-8">Limit</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {riders.map((rider) => {
                                    const tone = statusTone[rider.status] || statusTone.safe;
                                    return (
                                        <tr
                                            key={rider.id}
                                            className="group hover:bg-slate-50/40 transition-all cursor-pointer"
                                            onClick={() => setSelectedRider(rider)}
                                        >
                                            <td className="px-6 py-6 pl-8">
                                                <div className="flex items-center gap-4">
                                                    <div className="relative">
                                                        <img
                                                            src={rider.avatar || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}
                                                            alt=""
                                                            className="h-12 w-12 rounded-lg ring-2 ring-white shadow-sm object-cover bg-slate-100"
                                                        />
                                                        <div
                                                            className={cn(
                                                                'absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-white',
                                                                tone.dot,
                                                            )}
                                                        />
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-black text-slate-900">{rider.name}</p>
                                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter mt-0.5">
                                                            {shortRiderId(rider.id)} • {rider.heldJobs} open COD job
                                                            {rider.heldJobs === 1 ? '' : 's'}
                                                            {rider.pendingDepositCount > 0 && (
                                                                <span className="text-amber-600">
                                                                    {' '}• {rupees(rider.pendingDepositAmount)} awaiting review
                                                                </span>
                                                            )}
                                                        </p>
                                                    </div>
                                                </div>
                                            </td>

                                            <td className="px-6 py-6">
                                                <div className="space-y-2 max-w-[200px]">
                                                    <div className="flex justify-between items-end">
                                                        <span className="text-lg font-black text-slate-900">
                                                            {rupees(rider.currentCash)}
                                                        </span>
                                                        <span className="text-[10px] font-bold text-slate-400 uppercase">
                                                            of {rupees(rider.limit)}
                                                        </span>
                                                    </div>
                                                    <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                                                        <motion.div
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${Math.min(rider.usedPercent, 100)}%` }}
                                                            className={cn('h-full rounded-full', tone.bar)}
                                                        />
                                                    </div>
                                                    {/* Which product the cash came from — an admin chasing a
                                                        balance needs to know where to look. */}
                                                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">
                                                        Local {rupees(rider.localCash)} • Outstation{' '}
                                                        {rupees(rider.outstationCash)}
                                                    </p>
                                                </div>
                                            </td>

                                            <td className="px-6 py-6 text-right">
                                                <span
                                                    className={cn(
                                                        'text-sm font-black',
                                                        rider.remaining <= 0 ? 'text-rose-600' : 'text-slate-700',
                                                    )}
                                                >
                                                    {rupees(rider.remaining)}
                                                </span>
                                                <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">
                                                    {rider.usedPercent}% used
                                                </p>
                                            </td>

                                            <td className="px-6 py-6 text-center">
                                                <Badge
                                                    variant={tone.badge}
                                                    className="text-[9px] font-black px-3 py-1 uppercase tracking-widest"
                                                >
                                                    {tone.label}
                                                </Badge>
                                            </td>

                                            <td
                                                className="px-6 py-6 text-right pr-8"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="text-right">
                                                        <p className="text-xs font-black text-slate-900">
                                                            {rupees(rider.limit)}
                                                        </p>
                                                        <p className="text-[9px] font-bold text-slate-400 uppercase">
                                                            {rider.limitSource === 'rider' ? 'Custom' : 'Fleet default'}
                                                        </p>
                                                    </div>
                                                    <button
                                                        onClick={() => openLimitEditor(rider)}
                                                        className="p-2.5 bg-slate-50 text-slate-400 rounded-xl hover:bg-[color:var(--primary)] hover:text-white transition-all active:scale-95"
                                                        title="Set this rider's limit"
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}

                                {!loading && riders.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="py-16 text-center">
                                            <CircleDollarSign className="h-10 w-10 text-slate-200 mx-auto mb-3" />
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                                No riders match this search
                                            </p>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50/50 border-b border-slate-100">
                                    <th className="ds-table-header-cell pl-8 py-5">Settlement ID</th>
                                    <th className="ds-table-header-cell">Partner</th>
                                    <th className="ds-table-header-cell text-center">Amount</th>
                                    <th className="ds-table-header-cell">Method</th>
                                    <th className="ds-table-header-cell text-right pr-8">Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {historyData.map((log) => (
                                    <tr key={log.id} className="group hover:bg-slate-50/40 transition-all">
                                        <td className="px-6 py-5 pl-8 text-[10px] font-black text-slate-400 uppercase tracking-tighter">
                                            {log.id}
                                        </td>
                                        <td className="px-6 py-5 text-sm font-bold text-slate-900">{log.rider}</td>
                                        <td className="px-6 py-5 text-center text-sm font-black text-brand-600">
                                            {rupees(log.amount)}
                                        </td>
                                        <td className="px-6 py-5">
                                            <Badge
                                                variant="secondary"
                                                className="text-[9px] font-black px-2 py-0.5 uppercase"
                                            >
                                                {log.method}
                                            </Badge>
                                        </td>
                                        <td className="px-6 py-5 text-right pr-8 text-xs font-bold text-slate-500">
                                            {new Date(log.date).toLocaleDateString('en-IN', {
                                                day: 'numeric',
                                                month: 'short',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="px-6 py-3 border-t border-slate-100">
                    <Pagination
                        page={activeTab === 'live_balances' ? ridersPage : historyPage}
                        totalPages={
                            Math.ceil(
                                (activeTab === 'live_balances' ? ridersTotal : historyTotal) / pageSize,
                            ) || 1
                        }
                        total={activeTab === 'live_balances' ? ridersTotal : historyTotal}
                        pageSize={pageSize}
                        onPageChange={activeTab === 'live_balances' ? fetchRidersPage : fetchHistoryPage}
                        onPageSizeChange={(newSize) => {
                            setPageSize(newSize);
                            setRidersPage(1);
                            setHistoryPage(1);
                        }}
                        loading={loading}
                    />
                </div>
            </Card>

            {/* Rider detail */}
            <Modal
                isOpen={!!selectedRider}
                onClose={() => setSelectedRider(null)}
                title="Rider cash position"
                size="md"
            >
                {selectedRider && (
                    <div className="ds-section-spacing">
                        <div className="flex items-center gap-6 p-6 bg-slate-50 rounded-xl border border-slate-100 mt-4">
                            <img
                                src={selectedRider.avatar || 'https://cdn-icons-png.flaticon.com/512/149/149071.png'}
                                alt=""
                                className="h-20 w-20 rounded-xl shadow-xl ring-4 ring-white object-cover bg-gray-100"
                            />
                            <div>
                                <h3 className="text-2xl font-black text-slate-900 tracking-tight">
                                    {selectedRider.name}
                                </h3>
                                <div className="flex items-center gap-2 mt-2">
                                    <Badge variant={(statusTone[selectedRider.status] || statusTone.safe).badge}>
                                        {(statusTone[selectedRider.status] || statusTone.safe).label.toUpperCase()}
                                    </Badge>
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                        {selectedRider.phone || shortRiderId(selectedRider.id)}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-4">
                            <Card className="p-5 border-none bg-[color:var(--primary)] text-white rounded-xl relative overflow-hidden">
                                <p className="text-[10px] opacity-60 font-black uppercase tracking-widest mb-2">
                                    Holding
                                </p>
                                <h4 className="text-2xl font-black">{rupees(selectedRider.currentCash)}</h4>
                                <CircleDollarSign className="absolute -bottom-4 -right-4 h-20 w-20 opacity-10" />
                            </Card>
                            <Card className="p-5 border-none bg-slate-50 ring-1 ring-slate-100 rounded-xl">
                                <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-2">
                                    Limit
                                </p>
                                <h4 className="text-2xl font-black text-slate-900">{rupees(selectedRider.limit)}</h4>
                                <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase">
                                    {selectedRider.limitSource === 'rider' ? 'Custom' : 'Fleet default'}
                                </p>
                            </Card>
                            <Card className="p-5 border-none bg-slate-50 ring-1 ring-slate-100 rounded-xl">
                                <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-2">
                                    Remaining
                                </p>
                                <h4
                                    className={cn(
                                        'text-2xl font-black',
                                        selectedRider.remaining <= 0 ? 'text-rose-600' : 'text-slate-900',
                                    )}
                                >
                                    {rupees(selectedRider.remaining)}
                                </h4>
                            </Card>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="flex items-center gap-3 p-4 bg-white ring-1 ring-slate-100 rounded-2xl">
                                <MapPin className="h-4 w-4 text-brand-600" />
                                <div>
                                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                        Local deliveries
                                    </p>
                                    <p className="text-sm font-black text-slate-900">
                                        {rupees(selectedRider.localCash)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 p-4 bg-white ring-1 ring-slate-100 rounded-2xl">
                                <Package className="h-4 w-4 text-brand-600" />
                                <div>
                                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                        Outstation couriers
                                    </p>
                                    <p className="text-sm font-black text-slate-900">
                                        {rupees(selectedRider.outstationCash)}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {selectedRider.pendingDepositCount > 0 && (
                            <div className="flex items-start gap-3 p-4 bg-amber-50 ring-1 ring-amber-200 rounded-2xl">
                                <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-xs font-black text-amber-900 uppercase tracking-tight">
                                        {rupees(selectedRider.pendingDepositAmount)} waiting for approval
                                    </p>
                                    <p className="text-xs text-amber-800 mt-1">
                                        Approving the deposit on the Cash Deposits screen is what clears this
                                        cash and lets the rider take jobs again.
                                    </p>
                                </div>
                            </div>
                        )}

                        <button
                            onClick={() => {
                                openLimitEditor(selectedRider);
                                setSelectedRider(null);
                            }}
                            className="w-full py-4 bg-[color:var(--primary)] text-white rounded-2xl font-black text-[11px] uppercase tracking-widest shadow-xl transition-all active:scale-[0.98]"
                        >
                            Change this rider&apos;s limit
                        </button>
                    </div>
                )}
            </Modal>

            {/* Fleet-wide cash policy */}
            <Modal
                isOpen={isSettingsOpen}
                onClose={() => !isSaving && setIsSettingsOpen(false)}
                title="Cash policy"
                size="sm"
            >
                {settingsDraft && (
                    <div className="ds-section-spacing py-4">
                        <label className="flex items-start gap-3 p-4 bg-slate-50 rounded-2xl ring-1 ring-slate-100 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={settingsDraft.enforceCashLimit}
                                onChange={(e) =>
                                    setSettingsDraft({ ...settingsDraft, enforceCashLimit: e.target.checked })
                                }
                                className="mt-0.5 h-4 w-4 accent-slate-900"
                            />
                            <div>
                                <p className="text-xs font-black text-slate-900 uppercase tracking-tight">
                                    Enforce cash limits
                                </p>
                                <p className="text-xs text-slate-500 mt-1">
                                    Riders at their limit stop receiving local and outstation jobs until a
                                    deposit is approved. Turning this on takes effect immediately.
                                </p>
                            </div>
                        </label>

                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                Fleet default limit
                            </label>
                            <div className="flex items-center gap-2 mt-2 bg-slate-50 rounded-2xl ring-1 ring-slate-100 px-4 py-3">
                                <span className="text-lg font-black text-slate-900">₹</span>
                                <input
                                    type="number"
                                    min="0"
                                    value={settingsDraft.globalCashLimit}
                                    onChange={(e) =>
                                        setSettingsDraft({ ...settingsDraft, globalCashLimit: e.target.value })
                                    }
                                    className="bg-transparent text-lg font-black text-slate-900 w-full outline-none"
                                />
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1.5">
                                Applies to every rider without their own limit.
                            </p>
                        </div>

                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                Warn the rider at {settingsDraft.warnAtPercent}%
                            </label>
                            <input
                                type="range"
                                min="50"
                                max="100"
                                step="5"
                                value={settingsDraft.warnAtPercent}
                                onChange={(e) =>
                                    setSettingsDraft({ ...settingsDraft, warnAtPercent: e.target.value })
                                }
                                className="w-full mt-3 accent-slate-900"
                            />
                            <p className="text-[10px] text-slate-400 mt-1">
                                The rider app shows a warning from this point, so nobody is surprised when
                                jobs stop.
                            </p>
                        </div>

                        <label className="flex items-start gap-3 p-4 bg-slate-50 rounded-2xl ring-1 ring-slate-100 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={settingsDraft.requireApprovalToResume}
                                onChange={(e) =>
                                    setSettingsDraft({
                                        ...settingsDraft,
                                        requireApprovalToResume: e.target.checked,
                                    })
                                }
                                className="mt-0.5 h-4 w-4 accent-slate-900"
                            />
                            <div>
                                <p className="text-xs font-black text-slate-900 uppercase tracking-tight">
                                    Require approval before jobs resume
                                </p>
                                <p className="text-xs text-slate-500 mt-1">
                                    On: the rider stays blocked until you approve their deposit. Off: paying
                                    unblocks them straight away, and your approval only settles the books.
                                </p>
                            </div>
                        </label>

                        <div className="space-y-3 pt-2">
                            <button
                                onClick={saveSettings}
                                disabled={isSaving}
                                className="w-full py-4 bg-[color:var(--primary)] text-white rounded-2xl font-black text-[11px] uppercase tracking-widest hover:opacity-90 transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-50 active:scale-[0.98]"
                            >
                                {isSaving && <RotateCw className="h-4 w-4 animate-spin" />}
                                {isSaving ? 'SAVING...' : 'SAVE POLICY'}
                            </button>
                            <button
                                onClick={() => setIsSettingsOpen(false)}
                                disabled={isSaving}
                                className="w-full py-4 bg-white ring-1 ring-slate-200 text-slate-400 font-black text-[11px] uppercase tracking-widest rounded-2xl hover:bg-slate-50 transition-all active:scale-[0.98]"
                            >
                                CANCEL
                            </button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Per-rider limit */}
            <Modal
                isOpen={!!limitDraft}
                onClose={() => !isSaving && setLimitDraft(null)}
                title="Rider cash limit"
                size="sm"
            >
                {limitDraft && (
                    <div className="ds-section-spacing py-4">
                        <div className="text-center space-y-3">
                            <div className="h-16 w-16 bg-brand-50 text-brand-600 rounded-xl flex items-center justify-center mx-auto ring-1 ring-brand-100">
                                <ShieldCheck className="h-8 w-8" />
                            </div>
                            <div>
                                <h3 className="text-xl font-black text-slate-900 tracking-tight">
                                    {limitDraft.rider.name}
                                </h3>
                                <p className="text-xs text-slate-500 mt-1">
                                    Currently holding {rupees(limitDraft.rider.currentCash)}
                                </p>
                            </div>
                        </div>

                        <div className="bg-slate-50 p-5 rounded-xl ring-1 ring-slate-100">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                Limit for this rider
                            </label>
                            <div className="flex items-center gap-2 mt-2">
                                <span className="text-xl font-black text-slate-900">₹</span>
                                <input
                                    type="number"
                                    min="0"
                                    placeholder={`${limitDraft.rider.limit} (fleet default)`}
                                    value={limitDraft.value}
                                    onChange={(e) => setLimitDraft({ ...limitDraft, value: e.target.value })}
                                    className="bg-transparent text-xl font-black text-slate-900 w-full outline-none"
                                />
                            </div>
                            {/**
                              * Zero and blank mean different things and both are useful,
                              * so the difference is spelled out rather than left to be
                              * discovered.
                              */}
                            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                                Leave blank to follow the fleet default. Enter <strong>0</strong> to stop this
                                rider carrying any cash at all.
                            </p>
                        </div>

                        <div className="space-y-3">
                            <button
                                onClick={() => saveRiderLimit(false)}
                                disabled={isSaving}
                                className="w-full py-4 bg-[color:var(--primary)] text-white rounded-2xl font-black text-[11px] uppercase tracking-widest hover:opacity-90 transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-50 active:scale-[0.98]"
                            >
                                {isSaving && <RotateCw className="h-4 w-4 animate-spin" />}
                                SAVE LIMIT
                            </button>
                            {limitDraft.rider.riderLimitOverride != null && (
                                <button
                                    onClick={() => saveRiderLimit(true)}
                                    disabled={isSaving}
                                    className="w-full py-3 bg-white ring-1 ring-slate-200 text-slate-500 font-black text-[11px] uppercase tracking-widest rounded-2xl hover:bg-slate-50 transition-all active:scale-[0.98]"
                                >
                                    USE FLEET DEFAULT
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
};

export default CashCollection;
