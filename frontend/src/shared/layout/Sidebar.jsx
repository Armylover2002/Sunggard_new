import React, { useEffect, useState, useCallback } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import { cn } from "@/lib/utils";
import { HiChevronDown } from "react-icons/hi2";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { X, LogOut } from "lucide-react";
import { ParcelGlyph } from "@shared/components/auth/consignmentKit";
import { INK, MONO, RULE, RULE_LIGHT, dashedRule } from "@shared/design/tokens";

/** Admin runs a light-gray rail with black text and orange accents, instead
 *  of the dark ink rail every other desk uses. */
const ADMIN_RAIL = '#E7E9EC';

/**
 * The depot's index — the spine of the operations desk.
 *
 * Built in the consignment language (design.md §2): ink stock, mono captions,
 * dashed rules, no gradients and no coloured glows. The active row is marked
 * the way a filed section is marked — a brand rule down its edge — rather than
 * by a glowing pill, so the mark survives every theme preset.
 */

/** The 10px uppercase mono caption, on ink — or on the admin's gray rail. */
const RailCaption = ({ children, className, style }) => {
    const { role } = useAuth();
    return (
        <span
            className={cn(
                "text-[10px] font-medium",
                role === "admin" ? "text-slate-500" : "text-white/40",
                className,
            )}
            style={{
                display: "block",
                lineHeight: 1,
                textTransform: "uppercase",
                fontFamily: MONO,
                letterSpacing: "0.18em",
                ...style,
            }}
        >
            {children}
        </span>
    );
};

/**
 * Work waiting on someone. Amber, not red: a queue is correctable, not broken
 * (design.md §3). The number is mono because it is printed data.
 */
const Waiting = ({ count }) => {
    if (!count) return null;
    return (
        <span
            className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-[#B45309]/50 bg-[#B45309]/15 px-1.5 text-[10px] font-bold tabular-nums text-[#FBBF24]"
            style={{ fontFamily: MONO }}
            title={`${count} awaiting action`}
        >
            {count > 99 ? "99+" : count}
        </span>
    );
};

const rowBase =
    "group relative flex w-full select-none items-center justify-between gap-3 rounded-xl py-2.5 pl-4 pr-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]";

/** The filed-section mark: a brand rule down the leading edge. */
const ActiveEdge = () => (
    <span
        aria-hidden
        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[color:var(--primary)]"
    />
);

const SidebarItem = ({ item, isOpen, onToggle }) => {
    const location = useLocation();
    const { role } = useAuth();
    const isAdmin = role === 'admin';
    const badgeCount = Number(item?.badgeCount || 0);
    const hasChildren = item.children && item.children.length > 0;
    const isChildActive =
        hasChildren && item.children.some((child) => location.pathname === child.path);

    if (hasChildren) {
        const expanded = isChildActive || isOpen;
        return (
            <div className="my-0.5">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    className={cn(
                        rowBase,
                        expanded
                            ? isAdmin
                                ? "bg-[color:var(--primary)]/12 text-slate-900"
                                : "bg-white/[0.06] text-white"
                            : isAdmin
                                ? "text-slate-500 hover:bg-black/[0.04] hover:text-slate-900"
                                : "text-white/55 hover:bg-white/[0.04] hover:text-white",
                    )}
                >
                    {isChildActive && <ActiveEdge />}
                    <span className="flex min-w-0 items-center gap-3">
                        {item.icon && (
                            <item.icon
                                className={cn(
                                    "h-[18px] w-[18px] shrink-0 transition-colors",
                                    expanded
                                        ? "text-[color:var(--primary)]"
                                        : isAdmin
                                            ? "text-slate-400 group-hover:text-slate-600"
                                            : "text-white/40 group-hover:text-white/70",
                                )}
                            />
                        )}
                        <span className="truncate text-[13px] font-semibold tracking-tight">{item.label}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                        <Waiting count={!isOpen ? badgeCount : 0} />
                        <HiChevronDown
                            className={cn(
                                "h-3.5 w-3.5 transition-transform duration-200",
                                isAdmin ? "text-slate-400" : "text-white/35",
                                isOpen && (isAdmin ? "rotate-180 text-slate-600" : "rotate-180 text-white/60"),
                            )}
                        />
                    </span>
                </button>

                {/* Children hang off a dashed rule, the way sub-lines hang off a
                    manifest entry rather than sitting in their own box. */}
                {isOpen && (
                    <div className="relative py-1 pl-[26px] pr-1">
                        <span
                            aria-hidden
                            className="absolute bottom-2 left-[19px] top-2 w-px"
                            style={{
                                backgroundImage: dashedRule(isAdmin ? RULE : RULE_LIGHT, 3, 4),
                                backgroundSize: "1px 7px",
                            }}
                        />
                        {item.children.map((child) => {
                            const showChildBadge =
                                badgeCount > 0 && String(child?.path || "") === "/admin/support-tickets";
                            return (
                                <NavLink
                                    key={child.path}
                                    to={child.path}
                                    end={child.end !== undefined ? child.end : false}
                                    className={({ isActive }) =>
                                        cn(
                                            "flex items-center justify-between gap-2 rounded-lg py-2 pl-3 pr-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]",
                                            isActive
                                                ? isAdmin
                                                    ? "bg-[color:var(--primary)]/18 font-bold text-slate-900"
                                                    : "bg-white/[0.07] font-bold text-white"
                                                : isAdmin
                                                    ? "font-medium text-slate-500 hover:bg-black/[0.04] hover:text-slate-900"
                                                    : "font-medium text-white/45 hover:bg-white/[0.04] hover:text-white/80",
                                        )
                                    }
                                >
                                    {({ isActive }) => (
                                        <>
                                            <span className="flex min-w-0 items-center gap-2.5">
                                                <span
                                                    aria-hidden
                                                    className={cn(
                                                        "h-1 w-1 shrink-0 rounded-full transition-colors",
                                                        isActive
                                                            ? "bg-[color:var(--primary)]"
                                                            : isAdmin
                                                                ? "bg-slate-400"
                                                                : "bg-white/25",
                                                    )}
                                                />
                                                <span className="truncate">{child.label}</span>
                                            </span>
                                            {showChildBadge && <Waiting count={badgeCount} />}
                                        </>
                                    )}
                                </NavLink>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    return (
        <NavLink
            to={item.path}
            end={item.end !== undefined ? item.end : false}
            className={({ isActive }) =>
                cn(
                    rowBase,
                    "my-0.5",
                    isActive
                        ? isAdmin
                            ? "bg-[color:var(--primary)]/18 font-bold text-slate-900"
                            : "bg-white/[0.07] font-bold text-white"
                        : isAdmin
                            ? "font-semibold text-slate-500 hover:bg-black/[0.04] hover:text-slate-900"
                            : "font-semibold text-white/55 hover:bg-white/[0.04] hover:text-white",
                )
            }
        >
            {({ isActive }) => (
                <>
                    {isActive && <ActiveEdge />}
                    <span className="flex min-w-0 items-center gap-3">
                        {item.icon && (
                            <item.icon
                                className={cn(
                                    "h-[18px] w-[18px] shrink-0 transition-colors",
                                    isActive
                                        ? "text-[color:var(--primary)]"
                                        : isAdmin
                                            ? "text-slate-400 group-hover:text-slate-600"
                                            : "text-white/40 group-hover:text-white/70",
                                )}
                            />
                        )}
                        <span className="truncate text-[13px] tracking-tight">{item.label}</span>
                    </span>
                    <Waiting count={badgeCount} />
                </>
            )}
        </NavLink>
    );
};

const SidebarContent = ({ items, onClose, openMenu, handleToggle }) => {
    const { settings } = useSettings();
    const { user, role, logout } = useAuth();
    const appName = settings?.appName || "App";
    const logoUrl = settings?.logoUrl || "";
    const [logoBroken, setLogoBroken] = useState(false);
    const showLogo = Boolean(logoUrl) && !logoBroken;

    const isAdmin = role === "admin";

    return (
        <div
            className={cn("flex h-full min-h-0 flex-col", isAdmin ? "text-slate-900" : "text-white/80")}
            style={{ background: isAdmin ? ADMIN_RAIL : INK }}
        >
            {/* Carrier's mark. The carton glyph is the app's icon (design.md §2) —
                not a sparkle, and never on a gradient. */}
            <div className="flex h-[68px] shrink-0 items-center justify-between gap-3 px-5">
                <div className="flex min-w-0 items-center gap-3">
                    <span
                        className={cn(
                            "grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl border",
                            isAdmin
                                ? "border-slate-300 bg-white text-slate-900"
                                : "border-white/15 bg-white/10 text-white",
                        )}
                    >
                        {showLogo ? (
                            <img
                                src={logoUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                onError={() => setLogoBroken(true)}
                            />
                        ) : (
                            <ParcelGlyph size={18} />
                        )}
                    </span>
                    <span className="min-w-0">
                        <span
                            className={cn(
                                "block truncate text-[14px] font-extrabold leading-none tracking-tight",
                                isAdmin ? "text-slate-900" : "text-white",
                            )}
                        >
                            {appName}
                        </span>
                        {role === "seller" && (
                            <RailCaption className="mt-1.5">Seller desk</RailCaption>
                        )}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close navigation"
                    className={cn(
                        "rounded-lg p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--primary)] md:hidden",
                        isAdmin
                            ? "text-slate-500 hover:bg-black/5 hover:text-slate-900"
                            : "text-white/50 hover:bg-white/10 hover:text-white",
                    )}
                >
                    <X className="h-5 w-5" />
                </button>
            </div>

            <div className="px-5">
                <div
                    className="h-px w-full"
                    style={{ backgroundImage: dashedRule(isAdmin ? RULE : RULE_LIGHT) }}
                    aria-hidden
                />
            </div>

            <nav
                data-lenis-prevent
                className="custom-scrollbar-dark relative z-20 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
                style={{ WebkitOverflowScrolling: "touch" }}
            >
                <RailCaption className="px-4 pb-3">Sections</RailCaption>
                {items.map((item, idx) => (
                    <SidebarItem
                        key={item.path || item.label || idx}
                        item={item}
                        isOpen={openMenu === item.label}
                        onToggle={() => handleToggle(item.label)}
                    />
                ))}
            </nav>

            {/* Who is filing. The role is read, not asserted — the old footer
                said "Super Admin" to everyone. */}
            <div className="shrink-0 px-5 pb-5 pt-1">
                <div
                    className="h-px w-full"
                    style={{ backgroundImage: dashedRule(isAdmin ? RULE : RULE_LIGHT) }}
                    aria-hidden
                />
                <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <span
                            className={cn(
                                "grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-[13px] font-bold",
                                isAdmin
                                    ? "border-slate-300 bg-white text-slate-900"
                                    : "border-white/15 bg-white/10 text-white",
                            )}
                            style={{ fontFamily: MONO }}
                        >
                            {(user?.name?.[0] || "A").toUpperCase()}
                        </span>
                        <span className="min-w-0">
                            <span
                                className={cn(
                                    "truncate text-[13px] font-bold",
                                    isAdmin ? "text-slate-900" : "text-white",
                                )}
                                style={{ display: "block", lineHeight: 1 }}
                            >
                                {user?.name || "Admin"}
                            </span>
                            <RailCaption style={{ marginTop: 6 }}>{role || "admin"}</RailCaption>
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={logout}
                        aria-label="Sign out"
                        className={cn(
                            "rounded-lg p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]",
                            isAdmin
                                ? "text-slate-500 hover:bg-black/5 hover:text-slate-900"
                                : "text-white/45 hover:bg-white/10 hover:text-white",
                        )}
                    >
                        <LogOut className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
};

const Sidebar = ({ items, title, isOpen, onClose }) => {
    const { role } = useAuth();
    const location = useLocation();
    const reduce = useReducedMotion();

    const getActiveMenu = useCallback(() => {
        const match = items.find((item) =>
            item.children?.some((child) => location.pathname === child.path)
        );
        return match ? match.label : null;
    }, [items, location.pathname]);

    const [openMenu, setOpenMenu] = useState(getActiveMenu);

    useEffect(() => {
        const active = getActiveMenu();
        if (active) {
            setOpenMenu(active);
        }
    }, [getActiveMenu]);

    const handleToggle = (label) => {
        setOpenMenu((prev) => (prev === label ? null : label));
    };

    const commonProps = { items, title, onClose, openMenu, handleToggle };

    return (
        <>
            <aside
                className={cn(
                    "fixed inset-y-0 left-0 z-50 w-[272px] flex-col border-r border-slate-900/60 md:flex",
                    role === "admin" || role === "seller" ? "hidden md:flex" : "flex",
                )}
            >
                <SidebarContent {...commonProps} />
            </aside>

            <AnimatePresence mode="wait">
                {isOpen && (
                    <div className="fixed inset-0 z-[100] md:hidden">
                        <motion.div
                            initial={reduce ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={reduce ? undefined : { opacity: 0 }}
                            onClick={onClose}
                            className="absolute inset-0 bg-slate-950/70"
                        />
                        <motion.div
                            initial={reduce ? false : { x: "-100%" }}
                            animate={{ x: 0 }}
                            exit={reduce ? undefined : { x: "-100%" }}
                            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 34, mass: 0.8 }}
                            className="absolute inset-y-0 left-0 flex w-[272px] flex-col"
                        >
                            <SidebarContent {...commonProps} />
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
};

export default Sidebar;
