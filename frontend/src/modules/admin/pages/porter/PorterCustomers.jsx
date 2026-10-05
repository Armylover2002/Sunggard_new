import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Eye,
  Users,
  UserCheck,
  UserX,
  Package,
  IndianRupee,
  Loader2,
  ArrowUpDown,
  Phone,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import Card from "@shared/components/ui/Card";
import ConfirmDialog from "@shared/components/ui/ConfirmDialog";
import Pagination from "@shared/components/ui/Pagination";
import PageHeader from "@shared/components/ui/PageHeader";
import StatCard from "@shared/components/ui/StatCard";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import { cn } from "@/lib/utils";

const formatMoney = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const formatDate = (value) => {
  if (!value) return "Never";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Never";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

const SORT_OPTIONS = [
  { value: "totalBookings", label: "Most Bookings" },
  { value: "totalSpent", label: "Highest Spend" },
  { value: "lastBookingAt", label: "Recent Activity" },
  { value: "joinedDate", label: "Newest Customers" },
];

const PorterCustomers = () => {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState([]);
  const [stats, setStats] = useState({
    totalPorterCustomers: 0,
    active: 0,
    inactive: 0,
    totalBookings: 0,
    totalRevenue: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("totalBookings");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);

  const [statusTarget, setStatusTarget] = useState(null); // customer row pending confirm
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const fetchCustomers = useCallback(
    async (requestedPage = 1) => {
      setLoading(true);
      try {
        const params = {
          page: requestedPage,
          limit: pageSize,
          sortBy,
        };
        if (search.trim()) params.search = search.trim();
        if (statusFilter !== "all") params.status = statusFilter;

        const res = await adminPorterApi.getCustomers(params);
        const data = res?.data?.result || {};
        setCustomers(Array.isArray(data.items) ? data.items : []);
        setTotal(typeof data.total === "number" ? data.total : 0);
        setPage(typeof data.page === "number" ? data.page : requestedPage);
        if (data.stats) setStats(data.stats);
      } catch (err) {
        console.error(err);
        toast.error(err?.response?.data?.message || "Failed to load courier customers");
      } finally {
        setLoading(false);
      }
    },
    [pageSize, search, statusFilter, sortBy],
  );

  useEffect(() => {
    const timer = setTimeout(() => fetchCustomers(1), search ? 400 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, sortBy, pageSize]);

  const statCards = useMemo(
    () => [
      { label: "Courier Customers", value: stats.totalPorterCustomers, icon: Users, color: "text-slate-600", bg: "bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700" },
      { label: "Active", value: stats.active, icon: UserCheck, color: "text-orange-600", bg: "bg-orange-50 border border-orange-200 dark:bg-orange-950/40 dark:border-orange-800" },
      { label: "Inactive", value: stats.inactive, icon: UserX, color: "text-rose-600", bg: "bg-rose-50 border border-rose-200 dark:bg-rose-950/40 dark:border-rose-800" },
      { label: "Total Bookings", value: stats.totalBookings, icon: Package, color: "text-orange-600", bg: "bg-orange-50 border border-orange-200 dark:bg-orange-950/40 dark:border-orange-800" },
      { label: "Total Revenue", value: formatMoney(stats.totalRevenue), icon: IndianRupee, color: "text-amber-600", bg: "bg-amber-50 border border-amber-200 dark:bg-amber-950/40 dark:border-amber-800" },
    ],
    [stats],
  );

  const handleConfirmStatusChange = async () => {
    if (!statusTarget) return;
    const nextActive = !statusTarget.isActive;
    setUpdatingStatus(true);
    try {
      await adminPorterApi.updateCustomerStatus(statusTarget.id, nextActive);
      toast.success(
        `${statusTarget.name || "Customer"} marked as ${nextActive ? "active" : "inactive"}`,
      );
      setStatusTarget(null);
      fetchCustomers(page);
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.message || "Failed to update customer status");
    } finally {
      setUpdatingStatus(false);
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <PageHeader
        title="Courier Customers"
        description="Customers who have booked pickup or city couriers, with real booking counts and spend. Deactivating an account here blocks that customer from logging in or booking again."
        badge={<Badge variant="info">Courier Ops</Badge>}
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {statCards.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} color={s.color} bg={s.bg} />
        ))}
      </div>

      {/* Filter & Search Bar */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: "all", label: "All" },
              { id: "active", label: "Active" },
              { id: "inactive", label: "Inactive" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                  statusFilter === tab.id
                    ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, phone or email..."
                className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
            </div>

            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="w-full appearance-none rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-xs font-medium outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-slate-900 dark:text-white sm:w-44"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* Customer Table */}
      <Card className="overflow-hidden relative min-h-[300px] p-0">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 backdrop-blur-[1px] dark:bg-slate-900/60">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40">
              <tr>
                <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Customer</th>
                <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Bookings</th>
                <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Total Spent</th>
                <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Last Booking</th>
                <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Status</th>
                <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {!loading && customers.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon={Users}
                      title={
                        search || statusFilter !== "all"
                          ? "No customers match your filters"
                          : "No customer has booked a Courier delivery yet"
                      }
                    />
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} className="transition-colors hover:bg-slate-50/70 dark:hover:opacity-90/40">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <img
                          src={c.avatar}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-xl bg-slate-100 object-cover ring-1 ring-slate-200 dark:ring-slate-700"
                        />
                        <div className="min-w-0">
                          <p
                            onClick={() => navigate(`/admin/porter/customers/${c.id}`)}
                            className="cursor-pointer truncate text-sm font-semibold text-slate-900 hover:text-primary dark:text-white"
                          >
                            {c.name}
                          </p>
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                            <Phone className="h-3 w-3" />
                            <span className="font-mono">{c.phone}</span>
                          </div>
                          {c.email && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                              <Mail className="h-3 w-3" />
                              <span className="truncate">{c.email}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">
                        <Package className="h-3.5 w-3.5 text-primary" />
                        {c.totalBookings}
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {c.deliveredBookings} delivered
                        {c.cancelledBookings ? ` · ${c.cancelledBookings} cancelled` : ""}
                      </p>
                    </td>
                    <td className="px-5 py-4 font-mono text-sm font-bold text-slate-900 dark:text-white">
                      {formatMoney(c.totalSpent)}
                    </td>
                    <td className="px-5 py-4 text-xs font-medium text-slate-500 dark:text-slate-400">
                      {formatDate(c.lastBookingAt)}
                    </td>
                    <td className="px-5 py-4">
                      <Badge variant={c.isActive ? "success" : "error"}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", c.isActive ? "bg-orange-500" : "bg-rose-500")} />
                        {c.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setStatusTarget(c)}
                          title={c.isActive ? "Deactivate — blocks login" : "Activate — allows login"}
                          className={cn(
                            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                            c.isActive ? "bg-orange-500" : "bg-slate-300 dark:bg-slate-700",
                          )}
                        >
                          <span
                            className={cn(
                              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out",
                              c.isActive ? "translate-x-4" : "translate-x-0",
                            )}
                          />
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(`/admin/porter/customers/${c.id}`)}
                          className="rounded-lg bg-primary/10 p-2 text-primary transition-all hover:bg-primary hover:text-white"
                          title="View customer"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <Pagination
            page={page}
            totalPages={Math.ceil(total / pageSize) || 1}
            total={total}
            pageSize={pageSize}
            onPageChange={(p) => fetchCustomers(p)}
            onPageSizeChange={(newSize) => {
              setPageSize(newSize);
              setPage(1);
            }}
            loading={loading}
          />
        </div>
      </Card>

      {/* Status Change Confirmation */}
      <ConfirmDialog
        isOpen={Boolean(statusTarget)}
        onCancel={() => !updatingStatus && setStatusTarget(null)}
        onConfirm={handleConfirmStatusChange}
        title={statusTarget?.isActive ? "Deactivate customer?" : "Activate customer?"}
        message={
          statusTarget?.isActive
            ? `${statusTarget?.name || "This customer"} will not be able to log in or place new Courier bookings until reactivated.`
            : `${statusTarget?.name || "This customer"} will be able to log in and book Courier deliveries again.`
        }
        confirmLabel={updatingStatus ? "Updating..." : statusTarget?.isActive ? "Deactivate" : "Activate"}
        cancelLabel="Cancel"
        loading={updatingStatus}
        variant={statusTarget?.isActive ? "danger" : "primary"}
      />
    </div>
  );
};

export default PorterCustomers;
