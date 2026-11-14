import React from "react";
import { cn } from "@/lib/utils";

/**
 * CourierGo kit — the shared vocabulary of the parcel screens.
 *
 * Every screen in the supplied designs is assembled from the same handful of
 * parts: a mono label, a waybill card, a barcode, a status chip, a route
 * line, a step tracker. Keeping them here is what stops six screens drifting
 * into six dialects.
 */

/* ---------------------------------------------------------------- type ---- */

export const Label = ({ children, className, ...rest }) => (
  <p className={cn("sg-label text-sg-ink-3", className)} {...rest}>
    {children}
  </p>
);

export const Data = ({ children, className, ...rest }) => (
  <span className={cn("sg-data", className)} {...rest}>
    {children}
  </span>
);

/* ------------------------------------------------------------- surfaces ---- */

export const Card = ({ children, className, inverse = false, ...rest }) => (
  <div
    className={cn(
      "rounded-[var(--sg-r-xl)] border shadow-[var(--sg-shadow)]",
      inverse
        ? "bg-sg-surface-inverse border-transparent text-sg-ink-inverse"
        : "bg-sg-surface border-sg-line text-sg-ink",
      className,
    )}
    {...rest}
  >
    {children}
  </div>
);

/** The dashed tear between a consignment note's header and its body. */
export const Perforation = ({ className }) => (
  <div className={cn("sg-perforation", className)} aria-hidden="true" />
);

/* -------------------------------------------------------------- barcode ---- */

/**
 * Decorative barcode. Deliberately derived from the id it sits under, so two
 * different waybills never show the same bars — a barcode that is obviously
 * random reads as clip art.
 */
export const Barcode = ({ value = "", height = 34, className }) => {
  const seed = String(value) || "COURIERGO";
  const bars = React.useMemo(() => {
    const out = [];
    for (let i = 0; i < 48; i += 1) {
      const code = seed.charCodeAt(i % seed.length) + i * 7;
      out.push(1 + (code % 3));
    }
    return out;
  }, [seed]);

  return (
    <div
      className={cn("flex items-end gap-[2px]", className)}
      style={{ height }}
      aria-hidden="true"
    >
      {bars.map((w, i) => (
        <span
          key={i}
          className="bg-current"
          style={{ width: w, height: "100%", opacity: i % 5 === 0 ? 0.35 : 0.9 }}
        />
      ))}
    </div>
  );
};

/* ---------------------------------------------------------------- chips ---- */

const CHIP_TONES = {
  transit: "bg-sg-transit-soft text-sg-transit",
  done: "bg-sg-done-soft text-sg-done",
  warn: "bg-sg-warn-soft text-sg-warn",
  fail: "bg-sg-fail-soft text-sg-fail",
  idle: "bg-sg-surface-2 text-sg-ink-3",
};

export const StatusChip = ({ tone = "idle", icon: Icon, children, className }) => (
  <span
    className={cn(
      "sg-label inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
      CHIP_TONES[tone] || CHIP_TONES.idle,
      className,
    )}
  >
    {Icon ? <Icon className="h-3 w-3" /> : null}
    {children}
  </span>
);

/* ----------------------------------------------------------- route line ---- */

/**
 * The from → to pair. Vertical by default (history cards), horizontal when a
 * card is showing live progress along the leg.
 */
export const RouteLine = ({ from, to, fromMeta, toMeta, done = false, className }) => (
  <div className={cn("flex gap-3", className)}>
    <div className="flex flex-col items-center pt-1.5">
      <span
        className={cn(
          "h-2 w-2 rounded-full ring-2",
          done ? "bg-sg-done ring-sg-done/25" : "bg-sg-ink ring-sg-ink/15",
        )}
      />
      <span className="w-px flex-1 my-1 bg-sg-line-strong" />
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          done ? "bg-sg-done" : "border border-sg-line-strong bg-transparent",
        )}
      />
    </div>
    <div className="min-w-0 flex-1 space-y-3">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-sg-ink truncate">{from}</p>
        {fromMeta ? <Data className="text-[11px] text-sg-ink-3">{fromMeta}</Data> : null}
      </div>
      <div className="min-w-0">
        <p className="text-[14px] text-sg-ink-2 truncate">{to}</p>
        {toMeta ? <Data className="text-[11px] text-sg-ink-3">{toMeta}</Data> : null}
      </div>
    </div>
  </div>
);

/* --------------------------------------------------------- step tracker ---- */

/**
 * FROM · TO · WHAT · PAY.
 *
 * Numbering is legitimate here: this is a real sequence and the customer
 * needs to know how much is left.
 */
export const StepTracker = ({ steps, current = 0, onStepClick, className }) => (
  <div className={cn("flex items-start justify-between gap-2", className)}>
    {steps.map((step, index) => {
      const state = index < current ? "done" : index === current ? "active" : "todo";
      const reachable = index < current && typeof onStepClick === "function";

      return (
        <button
          key={step}
          type="button"
          disabled={!reachable}
          onClick={reachable ? () => onStepClick(index) : undefined}
          className={cn(
            "flex flex-1 flex-col items-center gap-2",
            reachable ? "cursor-pointer" : "cursor-default",
          )}
        >
          <span
            className={cn(
              "grid h-8 w-8 place-items-center rounded-full border-2 transition",
              state === "done" && "border-sg-accent bg-sg-accent",
              state === "active" && "border-sg-ink bg-transparent",
              state === "todo" && "border-sg-line-strong bg-transparent",
            )}
          >
            {state === "done" ? (
              <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden="true">
                <path
                  d="M2.5 6.2l2.3 2.3 4.7-5"
                  fill="none"
                  stroke="var(--sg-accent-ink)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : state === "active" ? (
              <span className="h-2.5 w-2.5 rounded-full bg-sg-ink" />
            ) : null}
          </span>
          <span
            className={cn(
              "sg-label",
              state === "todo" ? "text-sg-ink-3" : "text-sg-ink",
            )}
          >
            {step}
          </span>
        </button>
      );
    })}
  </div>
);

/* --------------------------------------------------------------- inputs ---- */

export const Field = ({ label, hint, children, className }) => (
  <label className={cn("block", className)}>
    <Label className="mb-1.5">{label}</Label>
    {children}
    {hint ? <p className="mt-1 text-[12px] text-sg-ink-3">{hint}</p> : null}
  </label>
);

export const inputClass = cn(
  "w-full rounded-[var(--sg-r)] border border-transparent bg-sg-surface-2",
  "px-3.5 py-3 text-[15px] text-sg-ink placeholder:text-sg-ink-3",
  "outline-none transition focus:border-sg-accent focus:bg-sg-surface",
);

/* -------------------------------------------------------------- buttons ---- */

export const PrimaryButton = ({ children, className, icon: Icon, ...rest }) => (
  <button
    type="button"
    className={cn(
      "sg-label inline-flex w-full items-center justify-center gap-2 rounded-[var(--sg-r-lg)]",
      "bg-sg-accent px-5 py-4 text-[13px] text-sg-accent-ink",
      "transition active:scale-[0.99] disabled:opacity-40 disabled:active:scale-100",
      className,
    )}
    {...rest}
  >
    {children}
    {Icon ? <Icon className="h-4 w-4" /> : null}
  </button>
);

export const GhostButton = ({ children, className, ...rest }) => (
  <button
    type="button"
    className={cn(
      "sg-label inline-flex items-center justify-center gap-2 rounded-[var(--sg-r-lg)]",
      "border border-sg-line px-4 py-3 text-[12px] text-sg-ink-2",
      "transition active:scale-[0.99] disabled:opacity-40",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

/* --------------------------------------------------------- service pick ---- */

/** Local Delivery ⇄ Outstation. The two products, side by side. */
export const ServiceToggle = ({ value, onChange, options, className }) => (
  <div
    role="tablist"
    className={cn(
      "grid grid-cols-2 gap-1 rounded-full border border-sg-line bg-sg-surface p-1",
      className,
    )}
  >
    {options.map((option) => {
      const active = option.value === value;
      return (
        <button
          key={option.value}
          role="tab"
          aria-selected={active}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "sg-label rounded-full px-4 py-2.5 transition",
            active
              ? "bg-sg-ink text-sg-ink-inverse"
              : "bg-transparent text-sg-ink-3",
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);

export const EmptyNote = ({ title, body, action }) => (
  <div className="rounded-[var(--sg-r-xl)] border border-dashed border-sg-line px-5 py-10 text-center">
    <p className="sg-heading text-[16px] text-sg-ink">{title}</p>
    {body ? <p className="mt-1.5 text-[13px] text-sg-ink-2">{body}</p> : null}
    {action ? <div className="mt-4">{action}</div> : null}
  </div>
);
