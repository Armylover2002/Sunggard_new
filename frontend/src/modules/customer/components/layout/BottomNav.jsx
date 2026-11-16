import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
    motion,
    useMotionValue,
    useSpring,
    useTransform,
    useVelocity,
    useReducedMotion,
} from 'framer-motion';
import { cn } from '@/lib/utils';
import { navItems, getActiveIndex } from './navItems';

/** Bar height, and the gap between the lens capsule and the bar edge, in px.
 *  The lens is a stadium that hugs its tab and echoes the bar's own geometry. */
const BAR_H = 58;
const LENS_INSET_Y = 4;
const LENS_INSET_X = 3;
const LENS_H = BAR_H - LENS_INSET_Y * 2;

/** Nav palette, in one place. Everything resolves from the app's centralized
 *  theme contract in index.css, so swapping a `--primary` preset (green /
 *  corporate blue / purple) re-themes the bar with no change here.
 *  The app is light-surfaced (--background #F8FAFC), so this is light-mode
 *  Liquid Glass rather than the App Store's dark appearance. */
const NAV_THEME = {
    '--nav-accent': 'var(--primary)',
    '--nav-idle': 'var(--muted-foreground, #64748B)',
    '--nav-bar': 'rgba(255,255,255,0.62)',
    '--nav-lens': 'rgba(255,255,255,0.55)',
    '--nav-tint': 'color-mix(in srgb, var(--primary) 12%, transparent)',
    '--nav-rim': 'color-mix(in srgb, var(--primary) 22%, rgba(255,255,255,0.85))',
    '--nav-glow': 'color-mix(in srgb, var(--primary) 40%, transparent)',
    '--nav-edge': 'rgba(15,23,42,0.10)',
    '--nav-shadow': 'rgba(15,23,42,0.16)',
};

const BottomNav = () => {
    const location = useLocation();
    const reduceMotion = useReducedMotion();

    const routeIndex = getActiveIndex(location.pathname);
    // Optimistic index so the lens leaves immediately on tap instead of waiting
    // for the route transition to commit. `from` records the route it was
    // issued against, so it self-expires once navigation lands.
    const [pending, setPending] = useState(null);
    const active = pending && pending.from === routeIndex ? pending.index : routeIndex;

    const navRef = useRef(null);
    const tabRefs = useRef([]);
    const settled = useRef(false);

    const springConfig = reduceMotion
        ? { stiffness: 1200, damping: 100, mass: 1 }
        : { stiffness: 380, damping: 30, mass: 1.1 };

    // Raw target -> spring gives the lens its weight and slight overshoot.
    // Width is sprung too, so the capsule morphs between tabs of unequal size
    // instead of snapping.
    const targetX = useMotionValue(0);
    const x = useSpring(targetX, springConfig);
    const targetW = useMotionValue(0);
    const width = useSpring(targetW, springConfig);

    // Velocity drives squash-and-stretch, lean, and chromatic fringing so the
    // lens reads as liquid rather than as a sliding rectangle. The amounts are
    // gentler than a circular lens would use: the same percentage stretch on a
    // capsule this wide reads as a rubber band rather than as glass.
    const rawVelocity = useVelocity(x);
    const velocity = useSpring(rawVelocity, { stiffness: 320, damping: 40, mass: 0.3 });

    const scaleX = useTransform(velocity, [-3000, 0, 3000], [1.11, 1, 1.11], { clamp: true });
    const scaleY = useTransform(velocity, [-3000, 0, 3000], [0.9, 1, 0.9], { clamp: true });
    const skewX = useTransform(velocity, [-3000, 0, 3000], [5, 0, -5], { clamp: true });
    const fringe = useTransform(velocity, [-2400, -120, 120, 2400], [1, 0, 0, 1], { clamp: true });
    const fringeShift = useTransform(velocity, [-3000, 3000], [3.5, -3.5], { clamp: true });
    const fringeShiftInv = useTransform(fringeShift, (v) => -v);

    const moveLens = useCallback((animate) => {
        const nav = navRef.current;
        const tab = tabRefs.current[active];
        if (!nav || !tab) return;

        const navBox = nav.getBoundingClientRect();
        const tabBox = tab.getBoundingClientRect();
        const nextX = tabBox.left - navBox.left + LENS_INSET_X;
        const nextW = Math.max(tabBox.width - LENS_INSET_X * 2, LENS_H);

        if (animate && settled.current) {
            targetX.set(nextX);
            targetW.set(nextW);
        } else {
            targetX.jump(nextX);
            x.jump(nextX);
            targetW.jump(nextW);
            width.jump(nextW);
            settled.current = true;
        }
    }, [active, targetX, x, targetW, width]);

    // Keep the lens locked to its tab through rotation / resize / font swaps,
    // without animating a jump the user did not trigger. The observer is
    // registered once and reads through a ref, so changing tabs never
    // re-triggers it (which would fire immediately and cut travel short).
    const moveLensRef = useRef(moveLens);

    useLayoutEffect(() => {
        moveLensRef.current = moveLens;
        moveLens(true);
    }, [moveLens]);

    useEffect(() => {
        const nav = navRef.current;
        if (!nav || typeof ResizeObserver === 'undefined') return;

        let lastWidth = nav.getBoundingClientRect().width;
        const ro = new ResizeObserver(([entry]) => {
            const width = entry.contentRect.width;
            if (width === lastWidth) return;
            lastWidth = width;
            moveLensRef.current(false);
        });
        ro.observe(nav);
        return () => ro.disconnect();
    }, []);

    const lensMotionStyle = reduceMotion
        ? { x, y: '-50%' }
        : { x, y: '-50%', scaleX, scaleY, skewX };

    return (
        <div
            className="fixed left-3 right-3 z-[500] md:hidden pointer-events-none"
            style={{ ...NAV_THEME, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        >
            <nav
                ref={navRef}
                aria-label="Primary"
                className="relative mx-auto w-full max-w-[420px] flex items-stretch pointer-events-auto select-none"
                style={{ height: BAR_H }}
            >
                {/* ---- Bar material -------------------------------------------------
                    Kept as a sibling of the lens (never an ancestor) so the lens
                    samples the page behind it rather than the already-blurred bar. */}
                <div
                    aria-hidden
                    className="absolute inset-0 rounded-full"
                    style={{
                        background: 'var(--nav-bar)',
                        backdropFilter: 'blur(28px) saturate(180%)',
                        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                        boxShadow:
                            'inset 0 1px 0.5px rgba(255,255,255,0.90), inset 0 0 0 0.5px var(--nav-edge), 0 12px 34px var(--nav-shadow), 0 2px 6px rgba(15,23,42,0.08)',
                    }}
                />

                {/* Specular sheen along the top of the capsule */}
                <div aria-hidden className="absolute inset-0 rounded-full overflow-hidden pointer-events-none">
                    <div
                        className="absolute inset-x-8 top-0 h-px"
                        style={{
                            background:
                                'linear-gradient(to right, transparent, rgba(255,255,255,0.95), transparent)',
                        }}
                    />
                    <div
                        className="absolute inset-x-0 top-0 h-1/2"
                        style={{
                            background:
                                'linear-gradient(to bottom, rgba(255,255,255,0.35), transparent)',
                        }}
                    />
                </div>

                {/* ---- Liquid glass lens ------------------------------------------- */}
                <motion.div
                    aria-hidden
                    className="absolute left-0 top-1/2 pointer-events-none"
                    style={{
                        ...lensMotionStyle,
                        width,
                        height: LENS_H,
                        zIndex: 1,
                        willChange: 'transform, width',
                    }}
                >
                    {/* Refraction body: brightens, saturates and lifts what is behind it */}
                    <div
                        className="absolute inset-0 rounded-full"
                        style={{
                            backdropFilter: 'blur(1.5px) saturate(190%) brightness(1.08)',
                            WebkitBackdropFilter: 'blur(1.5px) saturate(190%) brightness(1.08)',
                            backgroundColor: 'var(--nav-lens)',
                            backgroundImage:
                                'linear-gradient(to bottom, rgba(255,255,255,0.80) 0%, rgba(255,255,255,0.30) 48%, rgba(255,255,255,0.16) 72%, rgba(255,255,255,0.55) 100%), linear-gradient(to bottom, var(--nav-tint), var(--nav-tint))',
                            boxShadow:
                                'inset 0 1px 1px rgba(255,255,255,0.95), inset 0 -1px 1.5px rgba(255,255,255,0.55), inset 0 0 0 0.75px var(--nav-rim), 0 4px 12px rgba(15,23,42,0.14), 0 1px 3px rgba(15,23,42,0.10)',
                        }}
                    />

                    {/* Edge caustic — the bright hairline where glass meets air.
                        Masked with the content-box XOR trick so the rim follows a
                        stadium outline; a radial mask only works on a circle. */}
                    <div
                        className="absolute inset-0 rounded-full"
                        style={{
                            padding: '1.4px',
                            background:
                                'linear-gradient(150deg, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.30) 32%, rgba(255,255,255,0.25) 62%, rgba(255,255,255,0.90) 100%)',
                            WebkitMask:
                                'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                            WebkitMaskComposite: 'xor',
                            mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                            maskComposite: 'exclude',
                        }}
                    />

                    {/* Chromatic aberration — only while the lens is travelling.
                        Multiply rather than screen: on light glass a screen blend
                        has nothing left to brighten, so the fringe would vanish. */}
                    <motion.div
                        className="absolute inset-0 rounded-full"
                        style={{
                            opacity: fringe,
                            x: fringeShift,
                            mixBlendMode: 'multiply',
                            boxShadow: 'inset 0 0 0 1.5px rgba(255,138,76,0.55)',
                            filter: 'blur(0.5px)',
                        }}
                    />
                    <motion.div
                        className="absolute inset-0 rounded-full"
                        style={{
                            opacity: fringe,
                            x: fringeShiftInv,
                            mixBlendMode: 'multiply',
                            boxShadow: 'inset 0 0 0 1.5px rgba(66,150,255,0.55)',
                            filter: 'blur(0.5px)',
                        }}
                    />
                </motion.div>

                {/* ---- Tabs --------------------------------------------------------- */}
                {navItems.map((item, index) => {
                    const isActive = active === index;
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.path}
                            to={item.path}
                            ref={(el) => { tabRefs.current[index] = el; }}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => setPending({ index, from: routeIndex })}
                            className="relative z-[2] flex-1 flex items-center justify-center"
                        >
                            <motion.span
                                className="flex flex-col items-center justify-center gap-[3px] w-full h-full"
                                whileTap={{ scale: 0.9 }}
                                animate={{ scale: isActive ? 1.06 : 1 }}
                                transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                            >
                                <Icon
                                    size={23}
                                    strokeWidth={isActive ? 2.4 : 2}
                                    className="transition-colors duration-200"
                                    style={{
                                        color: isActive ? 'var(--nav-accent)' : 'var(--nav-idle)',
                                        filter: isActive
                                            ? 'drop-shadow(0 1px 5px var(--nav-glow))'
                                            : 'none',
                                    }}
                                />
                                <span
                                    className={cn(
                                        'text-[10px] leading-none tracking-[-0.01em] whitespace-nowrap transition-colors duration-200',
                                        isActive ? 'font-semibold' : 'font-medium'
                                    )}
                                    style={{ color: isActive ? 'var(--nav-accent)' : 'var(--nav-idle)' }}
                                >
                                    {item.label}
                                </span>
                            </motion.span>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
};

export default BottomNav;
