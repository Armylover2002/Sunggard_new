import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Receipt,
  Loader2,
  RotateCw,
  Package,
  CheckCircle2,
  Clock,
  Save,
  AlertTriangle,
  Calendar,
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
 * GST on porter bookings: the rate, and what it has brought in.
 *
 * LOCAL CITY PARCEL DISABLED — the local-delivery GST rate card is no longer
 * editable (the backend rejects `local` patches); only outstation's settings
 * render below. The report/ledger below still show historical "local" figures
 * for past bookings — that data stays for audit even though no new local
 * bookings can be created. Re-enable by restoring "local" to PRODUCTS.
 *
 * The report distinguishes CHARGED from COLLECTED on purpose. A COD booking
 * whose cash is still in a rider's pocket has charged GST nobody has received.
 * Showing one number for both is how an operation ends up remitting tax on
 * money it has not been given.
 */

const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// LOCAL CITY PARCEL DISABLED — only the outstation rate card is editable.
const PRODUCTS = [
  { key: "outstation", label: "Outstation courier", icon: Package },
];

const emptyGst = { enabled: false, percent: 18, inclusive: false, gstin: "", placeOfSupply: "" };

/** The first and last day of the current month, as yyyy-mm-dd. */
function currentMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(first), to: iso(now) };
}

const PorterGst = () => {
  const [settings, setSettings] = useState({ local: emptyGst, outstation: emptyGst });
  const [draft, setDraft] = useState({ local: emptyGst, outstation: emptyGst });
  const [report, setReport] = useState(null);
  const [ledger, setLedger] = useState({ items: [], total: 0, page: 1, totalPages: 1 });
  const [window, setWindow] = useState(currentMonth);
  const [ledgerSource, setLedgerSource] = useState("all");
  const [ledgerPage, setLedgerPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  /**
   * Settings, report and the first ledger page load together.
   *
   * The report's rates block and the settings form must agree — loading them
   * apart would let the headline say 18% while the form below still showed
   * the value from before a save.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, reportRes, ledgerRes] = await Promise.all([
        adminPorterApi.getGstSettings(),
        adminPorterApi.getGstReport(window),
        adminPorterApi.getGstLedger({ ...window, source: ledgerSource, page: ledgerPage, limit: 25 }),
      ]);
      const next = {
        local: { ...emptyGst, ...(settingsRes.data?.result?.local || {}) },
        outstation: { ...emptyGst, ...(settingsRes.data?.result?.outstation || {}) },
      };
      setSettings(next);
      setDraft(next);
      setReport(reportRes.data?.result || null);
      setLedger(ledgerRes.data?.result || { items: [], total: 0, page: 1, totalPages: 1 });
    } catch (error) {
      toast.error(error?.response?.data?.message || "Couldn't load GST data");
    } finally {
      setLoading(false);
    }
  }, [window, ledgerSource, ledgerPage]);

  useEffect(() => {
    load();
  }, [load]);

  const updateDraft = (product, patch) =>
    setDraft((prev) => ({ ...prev, [product]: { ...prev[product], ...patch } }));

  const isDirty = (product) =>
    JSON.stringify(draft[product]) !== JSON.stringify(settings[product]);

  const save = async (product) => {
    const value = draft[product];
    if (value.enabled && !(Number(value.percent) > 0)) {
      toast.error("Set a GST rate above zero before enabling it");
      return;
    }

    setSaving(product);
    try {
      await adminPorterApi.updateGstSettings({
        [product]: {
          enabled: value.enabled,
          percent: Number(value.percent),
          inclusive: value.inclusive,
          gstin: value.gstin.trim().toUpperCase(),
          placeOfSupply: value.placeOfSupply.trim(),
        },
      });
      toast.success(
        `${product === "local" ? "Local" : "Outstation"} GST saved — applies to new bookings`,
      );
      await load();
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save GST settings");
    } finally {
      setSaving(null);
    }
  };

  const headline = useMemo(() => {
    const combined = report?.combined;
    return [
      {
        label: "GST collected",
        value: rupees(combined?.collected?.gst),
        note: `${combined?.collected?.bookings ?? 0} settled bookings`,
        icon: CheckCircle2,
        color: "text-orange-600",
        bg: "bg-orange-50 border border-orange-100",
      },
      {
        label: "GST charged",
        value: rupees(combined?.charged?.gst),
        note: `${combined?.charged?.bookings ?? 0} bookings billed`,
        icon: Receipt,
        color: "text-slate-700",
        bg: "bg-slate-100 border border-slate-200",
      },
      {
        label: "Not yet collected",
        value: rupees(combined?.outstanding?.gst),
        note: "Mostly COD still with riders",
        icon: Clock,
        color: "text-amber-600",
        bg: "bg-amber-50 border border-amber-100",
      },
      {
        label: "Taxable value collected",
        value: rupees(combined?.collected?.taxable),
        note: "Before tax",
        icon: Calendar,
        color: "text-orange-600",
        bg: "bg-orange-50 border border-orange-100",
      },
    ];
  }, [report]);

  const maxSeries = Math.max(1, ...(report?.series || []).map((row) => row.totalGst || 0));

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <PageHeader
        title="GST"
        description="Set the GST rate for outstation bookings, and see what it has brought in (local delivery is disabled)."
        icon={Receipt}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-semibold text-slate-500">
              From
              <input
                type="date"
                value={window.from}
                max={window.to}
                onChange={(e) => {
                  setLedgerPage(1);
                  setWindow((prev) => ({ ...prev, from: e.target.value }));
                }}
                className="mt-1 block rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              To
              <input
                type="date"
                value={window.to}
                min={window.from}
                onChange={(e) => {
                  setLedgerPage(1);
                  setWindow((prev) => ({ ...prev, to: e.target.value }));
                }}
                className="mt-1 block rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </label>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--primary)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
            >
              <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Headline */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {headline.map((stat) => (
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

      {/* Per product: settings + figures */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {PRODUCTS.map(({ key, label, icon: Icon }) => {
          const value = draft[key];
          const figures = report?.[key];
          return (
            <Card key={key}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <Icon className="h-4 w-4 text-primary" />
                  {label}
                </h2>
                <Badge variant={settings[key].enabled ? "success" : "gray"}>
                  {settings[key].enabled ? `${settings[key].percent}% active` : "Off"}
                </Badge>
              </div>

              {/* Figures for the window */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  ["Collected", figures?.collected?.gst, "text-orange-600"],
                  ["Charged", figures?.charged?.gst, "text-slate-900 dark:text-white"],
                  ["Outstanding", figures?.outstanding?.gst, "text-amber-600"],
                ].map(([title, amount, tone]) => (
                  <div
                    key={title}
                    className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"
                  >
                    <p className="text-[10px] font-semibold uppercase text-slate-400">{title}</p>
                    <p className={cn("mt-0.5 text-sm font-bold", tone)}>{rupees(amount)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                CGST {rupees(figures?.collected?.cgst)} · SGST {rupees(figures?.collected?.sgst)}{" "}
                collected
              </p>

              {/* Settings */}
              <div className="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Charge GST on {label.toLowerCase()} bookings
                  </span>
                  <input
                    type="checkbox"
                    checked={value.enabled}
                    onChange={(e) => updateDraft(key, { enabled: e.target.checked })}
                    className="h-4 w-4 accent-slate-900"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-[11px] font-semibold text-slate-500">
                    Rate (%)
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={value.percent}
                      onChange={(e) => updateDraft(key, { percent: e.target.value })}
                      className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                    />
                  </label>
                  <label className="text-[11px] font-semibold text-slate-500">
                    GSTIN
                    <input
                      type="text"
                      maxLength={15}
                      placeholder="22AAAAA0000A1Z5"
                      value={value.gstin}
                      onChange={(e) => updateDraft(key, { gstin: e.target.value.toUpperCase() })}
                      className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-sm uppercase dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                    />
                  </label>
                </div>

                <label className="text-[11px] font-semibold text-slate-500">
                  Place of supply (state)
                  <input
                    type="text"
                    placeholder="e.g. Maharashtra"
                    value={value.placeOfSupply}
                    onChange={(e) => updateDraft(key, { placeOfSupply: e.target.value })}
                    className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  />
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <input
                    type="checkbox"
                    checked={value.inclusive}
                    onChange={(e) => updateDraft(key, { inclusive: e.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-slate-900"
                  />
                  <span>
                    <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Prices already include GST
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      On: the customer pays the quoted fare and tax is backed out of it. Off:
                      tax is added on top.
                    </span>
                  </span>
                </label>

                {/* A rate change never touches existing bookings — each stores the
                    rate it was sold at — and an admin should know that before saving. */}
                {isDirty(key) && (
                  <p className="flex items-start gap-1.5 text-[11px] text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Applies to new bookings only. Existing bookings keep the rate they were
                    sold at.
                  </p>
                )}

                <button
                  onClick={() => save(key)}
                  disabled={!isDirty(key) || saving === key}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[color:var(--primary)] py-2.5 text-xs font-bold text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
                >
                  {saving === key ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save {label.toLowerCase()} GST
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Monthly series */}
      {(report?.series || []).length > 0 && (
        <Card>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            GST collected by month
          </h2>
          <p className="text-[11px] text-slate-400">
            Collected, not charged — what a return is filed on.
          </p>
          <div className="mt-4 space-y-2.5">
            {report.series.map((row) => (
              <div key={row.period} className="grid grid-cols-[72px_1fr_110px] items-center gap-3">
                <span className="font-mono text-[11px] text-slate-500">{row.period}</span>
                <div className="flex h-5 overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${(row.localGst / maxSeries) * 100}%` }}
                    title={`Local ${rupees(row.localGst)}`}
                  />
                  <div
                    className="h-full bg-amber-400"
                    style={{ width: `${(row.outstationGst / maxSeries) * 100}%` }}
                    title={`Outstation ${rupees(row.outstationGst)}`}
                  />
                </div>
                <span className="text-right font-mono text-xs font-bold text-slate-900 dark:text-white">
                  {rupees(row.totalGst)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-primary" /> Local
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> Outstation
            </span>
          </div>
        </Card>
      )}

      {/* Line-by-line ledger */}
      <Card className="overflow-hidden" contentClassName="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">GST ledger</h2>
            <p className="text-[11px] text-slate-400">
              Settled bookings in this window, one row per invoice.
            </p>
          </div>
          <div className="flex gap-1.5">
            {[
              ["all", "All"],
              ["local", "Local"],
              ["outstation", "Outstation"],
            ].map(([key, text]) => (
              <button
                key={key}
                onClick={() => {
                  setLedgerSource(key);
                  setLedgerPage(1);
                }}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold",
                  ledgerSource === key
                    ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                )}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/60">
              <tr>
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Taxable</th>
                <th className="px-4 py-3 text-right">Rate</th>
                <th className="px-4 py-3 text-right">CGST</th>
                <th className="px-4 py-3 text-right">SGST</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </td>
                </tr>
              ) : ledger.items.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={Receipt}
                      title="No settled bookings"
                      description="No settled bookings in this window."
                    />
                  </td>
                </tr>
              ) : (
                ledger.items.map((row) => (
                  <tr key={`${row.source}-${row.id}`}>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                      {row.invoiceNo}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(row.date).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-600 dark:text-slate-300">
                      {row.source}
                      <span className="ml-1 text-slate-400">· {row.paymentMethod}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{rupees(row.taxable)}</td>
                    <td className="px-4 py-3 text-right font-mono">{row.gstPercent}%</td>
                    <td className="px-4 py-3 text-right font-mono">{rupees(row.cgst)}</td>
                    <td className="px-4 py-3 text-right font-mono">{rupees(row.sgst)}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-slate-900 dark:text-white">
                      {rupees(row.total)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {ledger.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs dark:border-slate-800">
            <span className="text-slate-400">
              Page {ledger.page} of {ledger.totalPages} · {ledger.total} rows
            </span>
            <div className="flex gap-2">
              <button
                disabled={ledgerPage <= 1}
                onClick={() => setLedgerPage((p) => p - 1)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-600 disabled:opacity-40 dark:border-slate-700"
              >
                Previous
              </button>
              <button
                disabled={ledgerPage >= ledger.totalPages}
                onClick={() => setLedgerPage((p) => p + 1)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-600 disabled:opacity-40 dark:border-slate-700"
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

export default PorterGst;
