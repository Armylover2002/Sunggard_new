/**
 * CourierGo design tokens — single source of truth for the "consignment note"
 * design language shared by every module.
 *
 * Colour lives in CSS custom properties (see src/index.css) so the theme
 * presets keep working; only the values that CSS can't express — font stacks,
 * timing, spring configs, the dashed-rule recipe — are defined here.
 *
 * See design.md at the repo root for the reasoning behind each value.
 */

/* ── Type ────────────────────────────────────────────────────────────────────
   Shipping data is monospaced everywhere it exists in the physical world:
   tracking numbers, weights, waybill captions. Numerals and field captions use
   the mono stack; prose stays on Outfit.                                     */

export const MONO =
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const PROSE = "'Outfit', 'Inter', system-ui, -apple-system, sans-serif";

/* ── Ink ─────────────────────────────────────────────────────────────────────
   Fixed paper/ink values that are deliberately *not* themeable: a consignment
   note is printed stock, and it reads as paper in every theme preset. Brand
   colour enters only through var(--primary).                                 */

export const INK = '#0F172A'; // slate-900 — the carrier's copy, headings
export const PAPER = '#FFFFFF'; // the note itself
export const COUNTER = '#F1F5F9'; // slate-100 — the booking counter behind it
export const RULE = 'rgba(15,23,42,0.18)'; // dashed rules, tear lines
export const RULE_LIGHT = 'rgba(255,255,255,0.22)'; // the same rule on ink
export const ALERT = '#B45309'; // amber — over-limit and rejected states

/* ── Admin theme override ───────────────────────────────────────────────────
   The admin console runs its own accent — orange — layered on top of the
   app-wide --primary preset in index.css. Spread this onto a wrapper's
   inline `style` so every var(--primary)-keyed surface underneath (buttons,
   active rows, stamps, focus rings) resolves to orange within that subtree,
   without touching the customer/seller/porter surfaces that share the same
   components.                                                              */
export const ADMIN_THEME_VARS = { '--primary': '#F97316' }; // orange-500

/* ── Motion ──────────────────────────────────────────────────────────────────
   Two engines, split by job. anime.js drives imperative, event-fired moments
   (a digit landing, a code box taking ink, a stamp hitting paper). motion.dev
   drives declarative state transitions (panes, layout, presence).            */

/** anime.js durations, in ms. */
export const DUR = {
    tap: 120,
    quick: 220,
    base: 380,
    pane: 520,
    stamp: 700,
};

/** anime.js easing names (v4). */
export const EASE = {
    out: 'outExpo',
    inOut: 'inOutQuad',
    back: 'outBack',
    elastic: 'outElastic',
};

/** motion.dev spring configs. */
export const SPRING = {
    /** Step panes sliding in and out. */
    pane: { type: 'spring', stiffness: 320, damping: 34, mass: 0.8 },
    /** Travelling pills and layout shifts. */
    pill: { type: 'spring', stiffness: 480, damping: 34, mass: 0.7 },
    /** Rubber stamps landing. */
    stamp: { type: 'spring', stiffness: 420, damping: 17, mass: 0.9 },
    /** The note arriving on the counter. */
    note: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
};

/** Collapses every spring to an instant cut for prefers-reduced-motion. */
export const STILL = { duration: 0 };

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** The dashed rule used for tear lines, leader dots and route segments. */
export const dashedRule = (color = RULE, on = 5, off = 6) =>
    `repeating-linear-gradient(to right, ${color} 0 ${on}px, transparent ${on}px ${on + off}px)`;

/** Paper elevation: a hairline plus a soft contact shadow, never a glow. */
export const LIFT =
    '0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -18px rgba(15,23,42,0.28)';

export const LIFT_HIGH =
    '0 2px 4px rgba(15,23,42,0.06), 0 32px 64px -28px rgba(15,23,42,0.40)';
