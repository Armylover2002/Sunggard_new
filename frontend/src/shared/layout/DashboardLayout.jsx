import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

import Sidebar from './Sidebar';
import Topbar from './Topbar';
import BottomNav from './BottomNav';
import { sellerApi } from '@/modules/seller/services/sellerApi';
import { useAuth } from "@core/context/AuthContext";
import { cn } from '@/lib/utils';
import SellerEarningsContext, { defaultEarnings } from '@/modules/seller/context/SellerEarningsContext';
import { ADMIN_THEME_VARS, COUNTER } from '@shared/design/tokens';

/** Counter ink for the dot grid — 5.5%, per the DepotGround recipe. */
const DOT = 'rgba(15,23,42,0.055)';

const DashboardLayout = ({ children, navItems, title }) => {
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const { role } = useAuth();
    const location = useLocation();

    const [sellerEarningsData, setSellerEarningsData] = useState(defaultEarnings);
    const [earningsLoading, setEarningsLoading] = useState(false);

    const refreshEarnings = useCallback(async () => {
        if (role !== 'seller') return;
        try {
            setEarningsLoading(true);
            const res = await sellerApi.getEarnings();
            if (res.data?.success) {
                setSellerEarningsData(res.data.result || defaultEarnings);
            }
        } catch {
            // Keep last known earnings data on failure.
        } finally {
            setEarningsLoading(false);
        }
    }, [role]);

    useEffect(() => {
        if (role === 'seller') {
            refreshEarnings();
        }
    }, [role, refreshEarnings]);

    useEffect(() => {
        setIsSidebarOpen(false);
    }, [location.pathname]);

    return (
        <div
            className="relative min-h-screen antialiased text-slate-900 selection:bg-[color:var(--primary)]/20"
            style={role === 'admin' ? { background: COUNTER, ...ADMIN_THEME_VARS } : { background: COUNTER }}
        >
            {/* The counter the paperwork lies on: a dot grid at 5.5% ink, the
                same ground the customer's note is filed against (design.md §6).
                Replaces the ambient gradient glows, which §3 rules out. */}
            <div
                aria-hidden
                className="pointer-events-none fixed inset-0 -z-10"
                style={{
                    backgroundImage: `radial-gradient(${DOT} 1px, transparent 1px)`,
                    backgroundSize: '22px 22px',
                }}
            />

            <Sidebar
                items={navItems}
                title={title}
                isOpen={isSidebarOpen}
                onClose={() => setIsSidebarOpen(false)}
            />

            <div className={cn(
                "flex min-h-screen flex-col",
                // The topbar is fixed on mobile and sticky from md up, so only
                // the mobile case needs to be cleared.
                (role === "admin" || role === "seller")
                    ? "pl-0 pt-[68px] md:pl-[272px] md:pt-0"
                    // This branch's topbar is fixed at every width, so the
                    // offset must not be dropped at md.
                    : "pl-[272px] pt-[68px]"
            )}>
                <Topbar onMenuClick={() => setIsSidebarOpen(true)} />
                
                <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-8 md:py-8">
                    <SellerEarningsContext.Provider
                        value={{
                            earningsData: role === 'seller' ? sellerEarningsData : defaultEarnings,
                            earningsLoading: role === 'seller' ? earningsLoading : false,
                            refreshEarnings,
                        }}
                    >
                        {children}
                    </SellerEarningsContext.Provider>
                </main>
            </div>
        </div>
    );
};

export default DashboardLayout;
