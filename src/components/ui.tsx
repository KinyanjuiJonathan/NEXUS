import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { ChevronRight, X } from "lucide-react";

export const cx = clsx;

type Variant = "primary" | "ghost" | "soft" | "danger" | "outline";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; icon?: ReactNode }>(
  function Button({ variant = "soft", size = "md", icon, className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none select-none whitespace-nowrap active:scale-[0.97]",
          size === "sm" && "h-8 px-3 text-[13px]",
          size === "md" && "h-9 px-3.5 text-sm",
          size === "lg" && "h-11 px-5 text-[15px]",
          variant === "primary" &&
            "text-white bg-gradient-to-r from-sky-500 via-blue-500 to-violet-500 shadow-[0_6px_24px_-8px_rgba(56,189,248,0.7)] hover:brightness-110",
          variant === "soft" && "bg-hover text-fg hover:bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]",
          variant === "ghost" && "text-fg-2 hover:bg-hover hover:text-fg",
          variant === "outline" && "border border-line-strong text-fg hover:bg-hover",
          variant === "danger" && "bg-[color-mix(in_oklab,var(--danger)_16%,transparent)] text-danger hover:bg-[color-mix(in_oklab,var(--danger)_26%,transparent)]",
          className,
        )}
        {...rest}
      >
        {icon}
        {children}
      </button>
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: number }>(
  function IconButton({ label, active, className, size = 32, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        style={{ width: size, height: size }}
        className={cx(
          "inline-flex items-center justify-center rounded-lg transition-colors duration-150 shrink-0",
          active ? "bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] text-accent" : "text-fg-2 hover:bg-hover hover:text-fg",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export function Card({ className, children, glow, ...rest }: React.HTMLAttributes<HTMLDivElement> & { glow?: boolean }) {
  return (
    <div className={cx("glass rounded-2xl", glow && "glow-ring", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, icon, right, subtitle }: { title: ReactNode; icon?: ReactNode; right?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && <span className="text-accent shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-fg-2 truncate">{title}</h3>
          {subtitle && <p className="text-xs text-muted truncate">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        "h-9 w-full rounded-xl bg-hover border border-line px-3 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "w-full rounded-xl bg-hover border border-line px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition resize-none",
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "h-9 w-full rounded-xl bg-hover border border-line px-2.5 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition [&>option]:bg-[var(--bg-2)]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("flex items-center justify-between gap-4 py-1.5", disabled ? "opacity-50" : "cursor-pointer")}>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-fg">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-gradient-to-r from-sky-500 to-violet-500" : "bg-line-strong",
        )}
      >
        <span className={cx("absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200", checked ? "translate-x-[22px]" : "translate-x-0.5")} />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-xl bg-hover p-1 gap-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          title={o.title}
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "relative rounded-lg font-medium transition-colors",
            size === "sm" ? "px-2.5 h-7 text-xs" : "px-3 h-8 text-[13px]",
            value === o.value ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${options.map((x) => x.value).join("")}`} className="absolute inset-0 rounded-lg bg-surface-2 shadow-sm border border-line" transition={{ type: "spring", stiffness: 500, damping: 40 }} />
          )}
          <span className="relative z-10 inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap", className)}
      style={color ? { color, background: `color-mix(in oklab, ${color} 16%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center rounded-md border border-line-strong bg-hover px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{children}</kbd>;
}

export function ProgressRing({ value, size = 64, stroke = 6, children, gradientId = "pr", color }: { value: number; size?: number; stroke?: number; children?: ReactNode; gradientId?: string; color?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value || 0));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-3)" />
            <stop offset="100%" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color ?? `url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.2,.8,.2,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

export function ProgressBar({ value, tone = "accent", className }: { value: number; tone?: "accent" | "danger" | "warning" | "success"; className?: string }) {
  const v = Math.min(1, Math.max(0, value || 0));
  return (
    <div className={cx("h-1.5 w-full rounded-full bg-line overflow-hidden", className)}>
      <div
        className={cx(
          "h-full rounded-full transition-[width] duration-700 ease-out",
          tone === "accent" && "bg-gradient-to-r from-cyan-400 via-sky-500 to-violet-500",
          tone === "danger" && "bg-danger",
          tone === "warning" && "bg-warning",
          tone === "success" && "bg-success",
        )}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 560, icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; icon?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // An open popup (date picker) inside the dialog takes Esc first.
      if (e.key === "Escape" && !document.querySelector("[data-popover]")) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button")?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            className="relative glass-strong rounded-2xl shadow-2xl w-full max-h-[84vh] flex flex-col"
            style={{ maxWidth: width }}
            initial={{ y: 16, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.98, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line">
              <div className="flex items-center gap-2.5 text-[15px] font-semibold">
                {icon && <span className="text-accent">{icon}</span>}
                {title}
              </div>
              <IconButton label="Close" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="px-5 py-4 scroll-y">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 gap-3">
      <div className="h-14 w-14 rounded-2xl glass flex items-center justify-center text-accent">{icon}</div>
      <div>
        <p className="font-semibold text-fg">{title}</p>
        {body && <p className="text-sm text-muted mt-1 max-w-sm">{body}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, icon, tone, sub, onClick, hint }: { label: string; value: ReactNode; icon: ReactNode; tone?: string; sub?: ReactNode; onClick?: () => void; hint?: string }) {
  const body = (
    <>
      <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0" style={{ color: tone ?? "var(--accent)", background: `color-mix(in oklab, ${tone ?? "var(--accent)"} 14%, transparent)` }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[22px] font-semibold leading-none tabular font-display">{value}</div>
        <div className={cx("text-xs text-muted mt-1", onClick ? "leading-tight" : "truncate")}>{label}</div>
        {sub && <div className="text-[11px] text-fg-2 mt-0.5 truncate">{sub}</div>}
      </div>
    </>
  );
  if (!onClick) return <Card className="p-4 flex items-center gap-3.5 min-w-0">{body}</Card>;
  // a statistic that opens its details: looks and behaves like a button
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ?? `Show ${label.toLowerCase()}`}
      className="group glass rounded-2xl p-4 flex items-center gap-3.5 min-w-0 text-left cursor-pointer transition duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--accent)_55%,transparent)] hover:shadow-[0_10px_30px_-14px_var(--glow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] active:translate-y-0"
    >
      {body}
      <ChevronRight size={16} className="ml-auto shrink-0 text-muted opacity-50 transition group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
    </button>
  );
}
