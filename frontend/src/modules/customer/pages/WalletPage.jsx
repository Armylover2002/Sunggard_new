import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, ArrowDownLeft, ChevronLeft, Wallet, Plus, Loader2, Globe } from 'lucide-react';
import { toast } from 'sonner';
import { customerApi } from '../services/customerApi';
import { openRazorpayCheckout } from '@shared/utils/razorpayCheckout';
import { useAuth } from '@core/context/AuthContext';
import { useSettings } from '@core/context/SettingsContext';

const formatDate = (d) => {
    if (!d) return '';
    const date = new Date(d);
    const now = new Date();
    const today = now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today) return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const QUICK_AMOUNTS = [100, 500, 1000, 2000];
const DEFAULT_LIMITS = { min: 10, max: 50000 };

const WalletPage = () => {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { settings } = useSettings();
    const appName = settings?.appName || 'App';

    const [balance, setBalance] = useState(0);
    const [limits, setLimits] = useState(DEFAULT_LIMITS);
    const [transactions, setTransactions] = useState([]);
    const [loading, setLoading] = useState(true);

    const [adding, setAdding] = useState(false);
    const [amount, setAmount] = useState('');
    const [paying, setPaying] = useState(false);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [summaryRes, txRes] = await Promise.all([
                customerApi.getWalletSummary(),
                customerApi.getWalletTransactions({ limit: 50 }),
            ]);
            const summary = summaryRes.data?.result ?? {};
            setBalance(summary.balance ?? 0);
            if (summary.topup) setLimits(summary.topup);

            const payload = txRes.data?.result ?? txRes.data?.data ?? {};
            setTransactions(Array.isArray(payload.items) ? payload.items : []);
        } catch (err) {
            console.error('Wallet fetch error:', err);
            setBalance(0);
            setTransactions([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const numericAmount = Number(amount);
    const amountProblem = !amount
        ? ''
        : !Number.isFinite(numericAmount) || numericAmount <= 0
            ? 'Enter a valid amount'
            : numericAmount < limits.min
                ? `Minimum ₹${limits.min}`
                : numericAmount > limits.max
                    ? `Maximum ₹${Number(limits.max).toLocaleString('en-IN')}`
                    : '';

    const handleAddMoney = async () => {
        if (!amount || amountProblem || paying) return;
        setPaying(true);
        try {
            const createRes = await customerApi.createWalletTopup({ amount: numericAmount });
            const order = createRes.data?.result;
            if (!order?.razorpay?.orderId) throw new Error('Could not start the payment');

            const receipt = await openRazorpayCheckout({
                keyId: order.razorpay.keyId,
                orderId: order.razorpay.orderId,
                amount: order.razorpay.amount,
                currency: order.razorpay.currency || 'INR',
                name: appName,
                description: `Add ₹${numericAmount} to wallet`,
                prefill: {
                    name: user?.name || '',
                    email: user?.email || '',
                    contact: user?.phone || '',
                },
            });

            // The wallet is credited by the server only once the bank has
            // confirmed the payment — never by this page.
            const verifyRes = await customerApi.verifyWalletTopup(receipt);
            const result = verifyRes.data?.result;
            if (typeof result?.balance === 'number') setBalance(result.balance);
            toast.success(`₹${numericAmount.toLocaleString('en-IN')} added to your wallet`);
            setAdding(false);
            setAmount('');
            fetchData();
        } catch (error) {
            if (error?.message === 'Payment cancelled') {
                toast.info('Payment cancelled. Nothing was added to your wallet.');
            } else if (error?.response?.status === 202) {
                toast.info(error.response.data?.message || 'Waiting for your bank to confirm the payment.');
                fetchData();
            } else {
                toast.error(
                    error?.response?.data?.message || error?.message || 'Could not add money. Please try again.',
                );
            }
        } finally {
            setPaying(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 pb-24 font-sans">
            <div className="sticky top-0 z-30 bg-slate-50/95 backdrop-blur-sm px-4 pt-4 pb-3 border-b border-slate-200/60 mb-4 flex items-center gap-2">
                <button
                    onClick={() => navigate(-1)}
                    className="w-10 h-10 flex items-center justify-center hover:bg-slate-200/70 rounded-full transition-colors -ml-1"
                >
                    <ChevronLeft size={22} className="text-slate-800" />
                </button>
                <h1 className="text-xl font-semibold text-slate-900 tracking-tight">Wallet</h1>
            </div>

            <div className="max-w-2xl mx-auto px-4 pt-1 relative z-20 space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Available Balance</p>
                            <h2 className="text-3xl font-semibold text-slate-900 mt-1">
                                {loading ? '...' : `₹${(balance || 0).toLocaleString('en-IN')}`}
                            </h2>
                        </div>
                        {!adding && (
                            <button
                                onClick={() => setAdding(true)}
                                className="inline-flex items-center gap-1.5 rounded-xl bg-[color:var(--primary)] px-4 py-2.5 text-sm font-bold text-white shadow-sm active:scale-95 transition"
                            >
                                <Plus size={16} />
                                Add money
                            </button>
                        )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                        Pay for courier bookings from your wallet. If you cancel, the money comes back here.
                    </p>

                    {adding && (
                        <div className="mt-4 border-t border-slate-100 pt-4 space-y-3">
                            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                                Amount to add
                            </label>
                            <div className="flex items-center rounded-xl border border-slate-200 bg-white px-3 focus-within:border-[color:var(--primary)] focus-within:ring-2 focus-within:ring-[color:var(--primary)]/15">
                                <span className="text-lg font-semibold text-slate-500 mr-1">₹</span>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min={limits.min}
                                    max={limits.max}
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    placeholder={`${limits.min} – ${Number(limits.max).toLocaleString('en-IN')}`}
                                    className="w-full py-3 text-lg font-semibold text-slate-900 outline-none bg-transparent"
                                    disabled={paying}
                                />
                            </div>
                            {amountProblem && (
                                <p className="text-xs font-semibold text-red-600">{amountProblem}</p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {QUICK_AMOUNTS.map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        disabled={paying}
                                        onClick={() => setAmount(String(value))}
                                        className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold border transition ${
                                            Number(amount) === value
                                                ? 'border-[color:var(--primary)] text-[color:var(--primary)] bg-[color:var(--primary)]/5'
                                                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                                        }`}
                                    >
                                        +₹{value.toLocaleString('en-IN')}
                                    </button>
                                ))}
                            </div>
                            <div className="flex gap-2 pt-1">
                                <button
                                    type="button"
                                    disabled={paying}
                                    onClick={() => {
                                        setAdding(false);
                                        setAmount('');
                                    }}
                                    className="flex-1 h-11 rounded-xl border border-slate-200 text-sm font-bold text-slate-600 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={!amount || Boolean(amountProblem) || paying}
                                    onClick={handleAddMoney}
                                    className="flex-[2] h-11 rounded-xl bg-[color:var(--primary)] text-sm font-bold text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
                                >
                                    {paying ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            Processing…
                                        </>
                                    ) : (
                                        `Add ₹${amount && !amountProblem ? numericAmount.toLocaleString('en-IN') : ''}`
                                    )}
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-400">
                                Money is added to your wallet only after your payment is confirmed.
                            </p>
                        </div>
                    )}
                </div>

                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                        <h3 className="text-base font-semibold text-slate-800">Transaction History</h3>
                        <Wallet size={18} className="text-slate-400" />
                    </div>

                    {loading ? (
                        <div className="py-12 flex justify-center text-slate-400 text-sm font-semibold">
                            Loading...
                        </div>
                    ) : transactions.length === 0 ? (
                        <div className="py-12 flex flex-col items-center justify-center text-center px-6">
                            <p className="text-sm font-semibold text-slate-500 mb-1">No wallet activity yet</p>
                            <p className="text-xs text-slate-400">
                                Money you add, wallet payments and refunds will appear here.
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-slate-100">
                            {transactions.map((tx) => {
                                // Payments/refunds that went through the gateway or cash never
                                // touched the wallet — shown, but not as wallet movements.
                                const offWallet = tx.affectsWallet === false;
                                return (
                                    <div key={tx._id} className="px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${
                                                offWallet
                                                    ? 'bg-slate-100 text-slate-400'
                                                    : tx.type === 'credit' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-700'
                                            }`}>
                                                {offWallet ? <Globe size={18} /> : tx.type === 'credit' ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}
                                            </div>
                                            <div className="min-w-0">
                                                <h4 className="font-semibold text-slate-800 text-sm truncate">{tx.title}</h4>
                                                <p className="text-[11px] text-slate-500">{formatDate(tx.date)}</p>
                                                {tx.orderId && (
                                                    <p className="text-[10px] text-slate-500">#{tx.orderId}</p>
                                                )}
                                                {!tx.orderId && tx.reference ? (
                                                    <p className="text-[10px] text-slate-400 truncate">{tx.reference}</p>
                                                ) : null}
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0 ml-3">
                                            <div className={`text-sm font-semibold ${
                                                offWallet ? 'text-slate-400' : tx.type === 'credit' ? 'text-emerald-600' : 'text-slate-900'
                                            }`}>
                                                {offWallet ? '' : tx.type === 'credit' ? '+' : '-'}₹{(tx.amount || 0).toLocaleString('en-IN')}
                                            </div>
                                            {offWallet && (
                                                <div className="text-[10px] text-slate-400">Wallet not affected</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default WalletPage;
