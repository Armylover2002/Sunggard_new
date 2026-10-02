import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@core/context/AuthContext';
import { LogOut, Bell, Menu } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { sellerApi } from '@/modules/seller/services/sellerApi';
import { adminApi } from '@/modules/admin/services/adminApi';
import { AnimatePresence } from 'framer-motion';
import NotificationPopup from './NotificationPopup';
import { toast } from 'sonner';
import { useSettings } from '@core/context/SettingsContext';
import { onNotificationNew } from '@core/services/orderSocket';
import { ParcelGlyph } from '@shared/components/auth/consignmentKit';
import { MONO, RULE, dashedRule } from '@shared/design/tokens';

const Topbar = ({ onMenuClick }) => {
    const { user, logout, role, token } = useAuth();
    const { settings } = useSettings();
    const navigate = useNavigate();
    const location = useLocation();

    const appName = settings?.appName || 'App';
    const logoUrl = settings?.logoUrl || '';

    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [showNotifications, setShowNotifications] = useState(false);
    const notificationRef = useRef(null);

    const isSeller = location.pathname.startsWith('/seller');
    const isAdmin = location.pathname.startsWith('/admin');

    const isSellerRef = useRef(isSeller);
    const isAdminRef = useRef(isAdmin);
    useEffect(() => { isSellerRef.current = isSeller; }, [isSeller]);
    useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);

    const fetchNotifications = useCallback(async () => {
        try {
            const sellerMode = isSellerRef.current;
            const adminMode = isAdminRef.current;
            if (!sellerMode && !adminMode) return;
            const response = sellerMode
                ? await sellerApi.getNotifications()
                : await adminApi.getNotifications();
            if (response.data.success) {
                setNotifications(response.data.result?.notifications || []);
                setUnreadCount(response.data.result?.unreadCount || 0);
            }
        } catch (error) {
            console.error("Notif Fetch Error:", error);
        }
    }, []);

    useEffect(() => {
        if (!isSeller && !isAdmin) return undefined;
        fetchNotifications();

        const getToken = () => token;
        let scheduled = null;
        const refresh = () => {
            if (scheduled) return;
            scheduled = setTimeout(() => {
                scheduled = null;
                fetchNotifications();
            }, 200);
        };

        const offNotification = token ? onNotificationNew(getToken, refresh) : null;
        const poll = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return;
            }
            fetchNotifications();
        }, 60000);

        return () => {
            clearInterval(poll);
            if (offNotification) offNotification();
        };
    }, [isSeller, isAdmin, token, fetchNotifications]);

    const handleMarkAsRead = async (notifId) => {
        try {
            if (isSeller) await sellerApi.markNotificationRead(notifId);
            if (isAdmin) await adminApi.markNotificationRead(notifId);
            setNotifications(prev =>
                prev.map(n => n._id === notifId ? { ...n, isRead: true } : n)
            );
            setUnreadCount(prev => Math.max(0, prev - 1));
        } catch (error) {
            toast.error("Failed to update notification");
        }
    };

    const handleNotificationClick = (notif) => {
        const link = notif?.data?.link || notif?.link;
        const parcelId = notif?.data?.parcelId || notif?.parcelId;
        const eventType = notif?.type || notif?.data?.eventType;

        setShowNotifications(false);

        if (link && typeof link === "string") {
            try {
                const url = new URL(link, window.location.origin);
                if (url.origin === window.location.origin) {
                    navigate(`${url.pathname}${url.search}${url.hash}`);
                    return;
                }
            } catch {
                /* fall through */
            }
        }

        if (isAdmin && (eventType === "PARCEL_REQUESTED" || parcelId)) {
            navigate(parcelId ? `/admin/parcels?parcelId=${parcelId}` : "/admin/parcels");
        }
    };

    const handleMarkAllAsRead = async () => {
        try {
            if (isSeller) await sellerApi.markAllNotificationsRead();
            if (isAdmin) await adminApi.markAllNotificationsRead();
            fetchNotifications();
            toast.success("All notifications cleared");
        } catch (error) {
            toast.error("Failed to mark all as read");
        }
    };

    return (
        <header
            className={cn(
                "z-40 flex items-center justify-between gap-4 border-b border-slate-200 bg-white",
                role === "admin" || role === "seller"
                    ? "fixed left-0 right-0 top-0 h-[68px] px-4 md:sticky md:top-0 md:px-7"
                    : "fixed left-[272px] right-0 top-0 h-[68px] px-7",
            )}
        >
            {/* Left: drawer trigger, mark on mobile, and the desk's one search. */}
            <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                    type="button"
                    onClick={onMenuClick}
                    aria-label="Open navigation"
                    className="rounded-xl border border-slate-200 p-2 text-slate-600 outline-none transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)] md:hidden"
                >
                    <Menu className="h-5 w-5" />
                </button>

                <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl border border-slate-200 bg-slate-900 text-white md:hidden">
                    {logoUrl ? (
                        <img src={logoUrl} alt={appName} className="h-full w-full object-cover" />
                    ) : (
                        <ParcelGlyph size={17} />
                    )}
                </span>

            </div>

            {/* Right: what is waiting, and who is filing. */}
            <div className="flex shrink-0 items-center gap-1.5">
                <div className="relative" ref={notificationRef}>
                    <button
                        type="button"
                        onClick={() => setShowNotifications(!showNotifications)}
                        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
                        className={cn(
                            "relative rounded-xl border p-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]",
                            showNotifications
                                ? "border-slate-300 bg-slate-50 text-slate-900"
                                : "border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900",
                        )}
                    >
                        <Bell className="h-[18px] w-[18px]" />
                        {unreadCount > 0 && (
                            <span
                                className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-md border border-white bg-[#B45309] px-1 text-[9px] font-bold tabular-nums text-white"
                                style={{ fontFamily: MONO }}
                            >
                                {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                        )}
                    </button>

                    <AnimatePresence>
                        {showNotifications && (
                            <NotificationPopup
                                notifications={notifications}
                                onMarkAsRead={handleMarkAsRead}
                                onMarkAllAsRead={handleMarkAllAsRead}
                                onNotificationClick={handleNotificationClick}
                                onClose={() => setShowNotifications(false)}
                            />
                        )}
                    </AnimatePresence>
                </div>

                <span
                    className="mx-1 hidden h-7 w-px sm:block"
                    style={{ backgroundImage: dashedRule(RULE), backgroundSize: "1px 8px" }}
                    aria-hidden
                />

                <button
                    type="button"
                    onClick={() => {
                        if (location.pathname.startsWith('/admin')) {
                            navigate('/admin/profile');
                        } else if (location.pathname.startsWith('/seller')) {
                            navigate('/seller/profile');
                        } else {
                            navigate('/profile');
                        }
                    }}
                    className="group flex items-center gap-2.5 rounded-xl p-1.5 pr-2.5 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                >
                    <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-900 text-[12px] font-bold text-white"
                        style={{ fontFamily: MONO }}
                    >
                        {(user?.name?.[0] || 'A').toUpperCase()}
                    </span>
                    <span className="hidden text-left sm:block">
                        <span className="block text-[13px] font-bold leading-none text-slate-900">
                            {user?.name || 'Admin'}
                        </span>
                        <span
                            className="mt-1.5 block text-[10px] font-medium uppercase leading-none text-slate-400"
                            style={{ fontFamily: MONO, letterSpacing: '0.18em' }}
                        >
                            {user?.role || role || 'admin'}
                        </span>
                    </span>
                </button>

                <button
                    type="button"
                    onClick={logout}
                    aria-label="Sign out"
                    title="Sign out"
                    className="rounded-xl border border-transparent p-2.5 text-slate-500 outline-none transition-colors hover:border-slate-200 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]"
                >
                    <LogOut className="h-[18px] w-[18px]" />
                </button>
            </div>
        </header>
    );
};

export default Topbar;
