import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

import { haptic } from "../telegram";
import { SwooshMark } from "./swoosh";

/* ------------------------------------------------------------------- layout */

/* The bottom padding clears the floating tab bar plus the home indicator below
   it, so the last row of a screen is never trapped under either. */
export const Screen = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div
    className={`relative z-10 mx-auto w-full max-w-[560px] px-4 pt-4 pb-[calc(7rem_+_env(safe-area-inset-bottom,0px))] ${className}`}
  >
    {children}
  </div>
);

export const PageTitle = ({ eyebrow, title, aside }: { eyebrow?: string; title: string; aside?: ReactNode }) => (
  <header className="mb-5 flex items-end justify-between gap-3">
    <div className="min-w-0">
      <h1 className="hero break-words">{title}</h1>
    </div>
    {aside}
  </header>
);

export const SectionRule = ({ label }: { label: string }) => (
  <div className="mt-7 mb-3 flex items-center gap-3">
    <span className="eyebrow shrink-0">{label}</span>
    <span className="hairline flex-1" />
  </div>
);

/* ------------------------------------------------------------------ buttons */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "solid" | "danger";
  size?: "md" | "sm";
  block?: boolean;
  loading?: boolean;
  sweep?: boolean;
};

export const Button = ({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  sweep = false,
  className = "",
  children,
  onClick,
  disabled,
  ...rest
}: ButtonProps) => (
  <button
    type="button"
    {...rest}
    disabled={disabled === true || loading}
    onClick={(event) => {
      haptic.tap(variant === "primary" ? "medium" : "light");
      onClick?.(event);
    }}
    className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${block ? "w-full" : ""} ${
      sweep ? "btn-sweep" : ""
    } ${className}`}
  >
    {loading ? <Spinner /> : null}
    {children}
  </button>
);

export const Spinner = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="spin-slow" aria-hidden>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

/* -------------------------------------------------------------------- chips */

export const Chip = ({
  children,
  tone = "plain",
  className = "",
}: {
  children: ReactNode;
  tone?: "plain" | "flare" | "soft";
  className?: string;
}) => (
  <span className={`chip ${tone === "flare" ? "chip-flare" : tone === "soft" ? "chip-soft" : ""} ${className}`}>
    {children}
  </span>
);

/* -------------------------------------------------------------- capacity bar */

export const Track = ({
  value,
  max,
  label,
  right,
}: {
  value: number;
  max: number | null;
  label: string;
  right?: string;
}) => {
  const ratio = max && max > 0 ? Math.min(1, value / max) : 0;
  const full = max !== null && value >= max;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        {/* Poster weight pairing: tracked-out label, plain numerals at full ink. */}
        <span className="num text-[11px] tracking-[0.14em] text-hint uppercase">{label}</span>
        {right ? <span className="num text-[11px] text-ink">{right}</span> : null}
      </div>
      <div className={`track ${full ? "track-full" : ""}`}>
        {max === null ? (
          /* Uncapped: a running row of lozenges rather than a filled bar. */
          <div
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage: "radial-gradient(closest-side, var(--flare) 0 68%, transparent 71%)",
              backgroundSize: "11px 100%",
              backgroundRepeat: "repeat-x",
            }}
          />
        ) : (
          <div className="track-fill" style={{ width: `${Math.max(ratio * 100, value > 0 ? 6 : 0)}%` }} />
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------- states */

export const Loader = ({ label }: { label: string }) => (
  <div className="fade-in flex flex-col items-center gap-3 py-16 text-hint">
    <Spinner size={22} />
    <span className="eyebrow">{label}</span>
  </div>
);

export const ErrorState = ({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel: string }) => (
  <div className="card fade-in px-5 py-6 text-center">
    <SwooshMark className="mx-auto mb-4 h-9 w-9" />
    <p className="mb-4 text-[15px]">{message}</p>
    {onRetry ? (
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    ) : null}
  </div>
);

export const EmptyState = ({ text, action }: { text: string; action?: ReactNode }) => (
  <div className="fade-in flex flex-col items-center gap-4 px-6 py-14 text-center">
    {/* The club's own mark as a watermark — the brand has one shape, so an
        empty screen shows that one rather than a stock glyph. */}
    <SwooshMark className="h-12 w-12 opacity-55" />
    <p className="max-w-[280px] text-[14px] leading-relaxed text-hint">{text}</p>
    {action}
  </div>
);

/* ------------------------------------------------------------------- inputs */

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <label className="block">
    <span className="eyebrow mb-1.5 block">{label}</span>
    {children}
    {hint ? <span className="mt-1 block text-[11px] text-hint">{hint}</span> : null}
  </label>
);

export const TextInput = ({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={`field ${className}`} {...rest} />
);

export const TextArea = ({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={`field resize-none ${className}`} rows={4} {...rest} />
);

export const SearchInput = ({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <div className={`relative ${className}`}>
    {/* The glyph sits on the input's own white plate, so it takes the input's
        ink rather than inheriting the surrounding context's. */}
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      className="absolute top-1/2 left-3.5 -translate-y-1/2"
      style={{ color: "var(--input-ph)" }}
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
    <input className="field pl-10" {...rest} />
  </div>
);

/* ------------------------------------------------------------------ numbers */

/* Poster numerals: a solid teal tile with the figure in white display type,
   the same move the date tile makes on an event card. */
export const StatTile = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="stattile px-4 py-3.5">
    <div className="eyebrow mb-1">{label}</div>
    <div className="display text-[28px] leading-[0.95] tabular-nums">{value}</div>
    {hint ? <div className="num mt-0.5 text-[11px] text-hint">{hint}</div> : null}
  </div>
);

export const MiniBar = ({ ratio, label, value }: { ratio: number; label: string; value: string }) => (
  <div className="py-1.5">
    <div className="mb-1 flex items-baseline justify-between">
      <span className="text-[13px]">{label}</span>
      <span className="num text-[13px]">{value}</span>
    </div>
    <div className="track h-1.5">
      <div className="track-fill" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
    </div>
  </div>
);
