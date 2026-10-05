import React, { useCallback, useEffect, useState } from "react";
import {
    LifeBuoy,
    Loader2,
    Send,
    MessageSquare,
    Package,
    RotateCw,
    User,
    Truck,
} from "lucide-react";
import { toast } from "sonner";
import Card from "@shared/components/ui/Card";
import Button from "@shared/components/ui/Button";
import PageHeader from "@shared/components/ui/PageHeader";
import Badge from "@shared/components/ui/Badge";
import EmptyState from "@shared/components/ui/EmptyState";
import { adminPorterApi } from "../../services/api/porterApi";
import { cn } from "@/lib/utils";

/**
 * Support tickets — raised by customers (/support) or delivery partners
 * (/delivery/profile/help-support). This is the porter desk's own view of
 * the shared ticket inbox; the general Help Tickets screen lists the same
 * data unfiltered.
 */

const STATUSES = [
    { key: "", label: "All" },
    { key: "open", label: "Open" },
    { key: "processing", label: "In progress" },
    { key: "closed", label: "Closed" },
];

const ORIGINS = [
    { key: "", label: "All" },
    { key: "customer", label: "Customer" },
    { key: "delivery", label: "Delivery" },
];

const STATUS_BADGE_VARIANT = {
    open: "warning",
    processing: "info",
    closed: "gray",
};

const isDeliveryTicket = (t) => t.userType === "Delivery" || t.userType === "Rider";

function originLabel(ticket) {
    return isDeliveryTicket(ticket) ? "Delivery Partner" : "Customer";
}

function OriginBadge({ ticket, className }) {
    const delivery = isDeliveryTicket(ticket);
    const Icon = delivery ? Truck : User;
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider",
                delivery
                    ? "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                    : "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
                className,
            )}
        >
            <Icon className="h-3 w-3" />
            {originLabel(ticket)}
        </span>
    );
}

const PorterTickets = () => {
    const [tickets, setTickets] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [status, setStatus] = useState("");
    const [origin, setOrigin] = useState("");
    const [selected, setSelected] = useState(null);
    const [reply, setReply] = useState("");
    const [sending, setSending] = useState(false);

    const fetchTickets = useCallback(
        async (isManual = false) => {
            if (isManual) setRefreshing(true);
            try {
                const res = await adminPorterApi.getTickets({ limit: 100 });
                if (res.data.success) {
                    setTickets(res.data.result?.items || []);
                }
            } catch (error) {
                console.error("Courier tickets error:", error);
                toast.error(
                    error?.response?.data?.message || "Couldn't load tickets",
                );
            } finally {
                setLoading(false);
                if (isManual) setRefreshing(false);
            }
        },
        [],
    );

    useEffect(() => {
        fetchTickets();
    }, [fetchTickets]);

    // Filtered client-side: the list is one page of tickets, so a round trip
    // per tab would cost more than it saves.
    const visible = tickets.filter((t) => {
        if (status && t.status !== status) return false;
        if (origin === "delivery" && !isDeliveryTicket(t)) return false;
        if (origin === "customer" && isDeliveryTicket(t)) return false;
        return true;
    });

    const sendReply = async () => {
        const text = reply.trim();
        if (!text || !selected) return;

        setSending(true);
        try {
            const res = await adminPorterApi.replyTicket(selected._id, text);
            if (res.data.success) {
                toast.success("Reply sent");
                setReply("");
                const updated = res.data.result;
                if (updated) setSelected(updated);
                fetchTickets();
            }
        } catch (error) {
            console.error("Reply failed:", error);
            toast.error(error?.response?.data?.message || "Couldn't send the reply");
        } finally {
            setSending(false);
        }
    };

    const changeStatus = async (next) => {
        if (!selected) return;
        try {
            const res = await adminPorterApi.updateTicketStatus(selected._id, next);
            if (res.data.success) {
                toast.success(`Marked ${next}`);
                setSelected((t) => ({ ...t, status: next }));
                fetchTickets();
            }
        } catch (error) {
            console.error("Status change failed:", error);
            toast.error(error?.response?.data?.message || "Couldn't update the status");
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Courier Support"
                description="Complaints raised by customers and delivery partners land here."
                icon={LifeBuoy}
                actions={
                    <button
                        onClick={() => fetchTickets(true)}
                        className="inline-flex items-center gap-2 rounded-2xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-primary/90"
                    >
                        <RotateCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
                        Refresh
                    </button>
                }
            />

            <Card className="p-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                    {STATUSES.map((s) => {
                        const count = s.key
                            ? tickets.filter((t) => t.status === s.key).length
                            : tickets.length;
                        return (
                            <button
                                key={s.key || "all"}
                                onClick={() => setStatus(s.key)}
                                className={cn(
                                    "rounded-xl px-4 py-2 text-xs font-bold transition",
                                    status === s.key
                                        ? "bg-primary text-white"
                                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
                                )}
                            >
                                {s.label} ({count})
                            </button>
                        );
                    })}
                </div>
                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    {ORIGINS.map((o) => {
                        const count = o.key
                            ? tickets.filter((t) => (o.key === "delivery" ? isDeliveryTicket(t) : !isDeliveryTicket(t))).length
                            : tickets.length;
                        return (
                            <button
                                key={o.key || "all-origin"}
                                onClick={() => setOrigin(o.key)}
                                className={cn(
                                    "rounded-xl px-4 py-2 text-xs font-bold transition",
                                    origin === o.key
                                        ? "bg-[color:var(--primary)] text-white dark:bg-white dark:text-slate-900"
                                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
                                )}
                            >
                                {o.label} ({count})
                            </button>
                        );
                    })}
                </div>
            </Card>

            {loading ? (
                <div className="flex h-64 items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
                    {/* List */}
                    <div className="space-y-3 lg:col-span-2">
                        {visible.length === 0 ? (
                            <Card>
                                <EmptyState icon={Package} title="No tickets here" />
                            </Card>
                        ) : (
                            visible.map((ticket) => (
                                <button
                                    key={ticket._id}
                                    onClick={() => {
                                        setSelected(ticket);
                                        setReply("");
                                    }}
                                    className={cn(
                                        "w-full rounded-2xl border bg-white p-4 text-left transition dark:bg-slate-900",
                                        selected?._id === ticket._id
                                            ? "border-primary/60 ring-2 ring-primary/10"
                                            : "border-slate-200/80 hover:border-primary/30 dark:border-slate-800",
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <p className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900 dark:text-white">
                                            {ticket.subject || "Untitled"}
                                        </p>
                                        <Badge
                                            variant={STATUS_BADGE_VARIANT[ticket.status] || STATUS_BADGE_VARIANT.closed}
                                            className="shrink-0"
                                        >
                                            {ticket.status}
                                        </Badge>
                                    </div>
                                    <div className="mt-1.5 flex items-center gap-1.5">
                                        <OriginBadge ticket={ticket} />
                                        <span className="truncate text-xs text-slate-500">
                                            {ticket.userId?.name || originLabel(ticket)}
                                            {ticket.relatedParcelId
                                                ? ` · ${ticket.relatedParcelId}`
                                                : ""}
                                        </span>
                                    </div>
                                    <p className="mt-1.5 text-[11px] text-slate-400">
                                        {ticket.messages?.length || 0} message
                                        {(ticket.messages?.length || 0) === 1 ? "" : "s"}
                                    </p>
                                </button>
                            ))
                        )}
                    </div>

                    {/* Thread */}
                    <div className="lg:col-span-3">
                        {!selected ? (
                            <Card className="flex h-full min-h-[280px] flex-col items-center justify-center">
                                <EmptyState icon={MessageSquare} title="Pick a ticket to read and reply" />
                            </Card>
                        ) : (
                            <Card className="flex h-full flex-col p-0">
                                <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5 dark:border-slate-800">
                                    <div className="min-w-0">
                                        <h3 className="truncate text-base font-extrabold text-slate-900 dark:text-white">
                                            {selected.subject || "Untitled"}
                                        </h3>
                                        <div className="mt-1 flex items-center gap-1.5">
                                            <OriginBadge ticket={selected} />
                                            <p className="truncate text-xs text-slate-500">
                                                {selected.userId?.name || originLabel(selected)}
                                                {selected.userId?.email
                                                    ? ` · ${selected.userId.email}`
                                                    : ""}
                                            </p>
                                        </div>
                                        {selected.relatedParcelId && (
                                            <p className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                                <Package className="h-3 w-3" />
                                                {selected.relatedParcelId}
                                            </p>
                                        )}
                                    </div>
                                    <select
                                        value={selected.status}
                                        onChange={(e) => changeStatus(e.target.value)}
                                        className="shrink-0 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-bold outline-none dark:border-slate-700 dark:bg-slate-900"
                                    >
                                        <option value="open">Open</option>
                                        <option value="processing">In progress</option>
                                        <option value="closed">Closed</option>
                                    </select>
                                </div>

                                <div className="max-h-[380px] flex-1 space-y-3 overflow-y-auto p-5">
                                    {(selected.messages || []).length === 0 ? (
                                        <p className="py-8 text-center text-sm text-slate-400">
                                            No messages yet
                                        </p>
                                    ) : (
                                        selected.messages.map((m, i) => {
                                            const fromAdmin = m.senderType === "Admin";
                                            return (
                                                <div
                                                    key={i}
                                                    className={cn(
                                                        "max-w-[85%] rounded-2xl px-4 py-2.5",
                                                        fromAdmin
                                                            ? "ml-auto bg-primary/10 text-slate-900 dark:text-slate-100"
                                                            : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
                                                    )}
                                                >
                                                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                                        {m.sender || (fromAdmin ? "Support" : originLabel(selected))}
                                                    </p>
                                                    {m.text && (
                                                        <p className="mt-0.5 whitespace-pre-wrap text-sm">
                                                            {m.text}
                                                        </p>
                                                    )}
                                                    {m.mediaUrl && (
                                                        <img
                                                            src={m.mediaUrl}
                                                            alt=""
                                                            className="mt-2 max-h-48 rounded-xl object-cover"
                                                        />
                                                    )}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>

                                <div className="flex items-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
                                    <textarea
                                        rows={2}
                                        value={reply}
                                        onChange={(e) => setReply(e.target.value)}
                                        placeholder={`Reply to the ${originLabel(selected).toLowerCase()}…`}
                                        className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/10 dark:border-slate-700 dark:bg-slate-900"
                                    />
                                    <Button
                                        onClick={sendReply}
                                        isLoading={sending}
                                        disabled={!reply.trim()}
                                        className="gap-2"
                                    >
                                        <Send className="h-4 w-4" />
                                        Send
                                    </Button>
                                </div>
                            </Card>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PorterTickets;
