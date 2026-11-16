import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Package } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useSettings } from '@core/context/SettingsContext';
import { navItems, getActiveIndex } from './navItems';
import { MONO, SPRING, STILL } from '@shared/design/tokens';

/**
 * Customer navigation for pointer-sized screens.
 *
 * BottomNav is a floating lens bar that hides itself at `md`, and the legacy
 * quick-commerce Header is suppressed on every live route — which left desktop
 * with no way to reach History or Profile at all. This is the same destination
 * list presented as a top bar: mono captions and a travelling rule, so it reads
 * as the consignment note's header rather than a second design language.
 */
const DesktopNav = () => {
    const location = useLocation();
    const reduce = useReducedMotion();
    const { settings } = useSettings();

    const carrier = settings?.appName || 'App';
    const logoUrl = settings?.logoUrl || '';
    const active = getActiveIndex(location.pathname);

    // The breakpoint lives on the sticky element itself: wrapping it in a
    // `hidden md:block` div would make that div the containing block and
    // confine the stick to its own height.
    return (
        <header className="sticky top-0 z-[450] hidden border-b border-slate-200 bg-white/85 backdrop-blur-xl md:block">
            <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
                <Link
                    to="/parcel"
                    className="flex items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--primary)] focus-visible:ring-offset-2"
                >
                    {logoUrl ? (
                        <img src={logoUrl} alt={carrier} className="h-10 w-auto max-w-[180px] object-contain" />
                    ) : (
                        <>
                            <span
                                className="grid h-9 w-9 place-items-center rounded-xl text-[color:var(--primary)]"
                                style={{ background: 'color-mix(in srgb, var(--primary) 12%, transparent)' }}
                            >
                                <Package size={19} strokeWidth={2.4} />
                            </span>
                            <span className="text-[16px] font-extrabold tracking-tight text-slate-900">
                                {carrier}
                            </span>
                        </>
                    )}
                </Link>

                <nav className="flex items-center gap-1" aria-label="Main">
                    {navItems.map((item, index) => {
                        const isActive = index === active;
                        const Icon = item.icon;
                        return (
                            <Link
                                key={item.path}
                                to={item.path}
                                aria-current={isActive ? 'page' : undefined}
                                className={cn(
                                    'relative flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[11px] uppercase tracking-[0.16em] font-bold',
                                    'outline-none transition-colors duration-200',
                                    'focus-visible:ring-2 focus-visible:ring-[color:var(--primary)] focus-visible:ring-offset-2',
                                    isActive
                                        ? 'text-[color:var(--primary)]'
                                        : 'text-slate-500 hover:text-slate-900',
                                )}
                                style={{ fontFamily: MONO }}
                            >
                                <Icon size={16} strokeWidth={2.4} />
                                {item.label}
                                {isActive && (
                                    <motion.span
                                        layoutId="desktop-nav-rule"
                                        className="absolute inset-x-2 -bottom-[9px] h-[2px] rounded-full"
                                        style={{ background: 'var(--primary)' }}
                                        transition={reduce ? STILL : SPRING.pill}
                                    />
                                )}
                            </Link>
                        );
                    })}
                </nav>
            </div>
        </header>
    );
};

export default DesktopNav;
