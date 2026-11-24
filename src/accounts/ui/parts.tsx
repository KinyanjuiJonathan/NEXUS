import { useState, type ReactNode } from "react";
import { Button, Modal, cx } from "@/components/ui";

/** A figure with its label, for the summaries. */
export function Figure({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-hover px-3 py-2.5 min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-muted truncate">{label}</div>
      <div className="font-mono tabular text-[15px] font-semibold truncate mt-0.5" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

export function Pill({ children, tone = "var(--muted)" }: { children: ReactNode; tone?: string }) {
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>{children}</span>;
}

/** A simple table that scrolls sideways on a narrow window. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto scroll-y", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-muted">
            {head.map((h, i) => <th key={i} className={cx("font-semibold px-3 py-2 whitespace-nowrap", i > 0 && typeof h === "string" && /amount|revenue|pay|share|tax|due|earned|paid|profit|hours|rate/i.test(h) && "text-right")}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
      </table>
    </div>
  );
}
export const td = "px-3 py-2 align-middle";
export const num = "px-3 py-2 align-middle text-right font-mono tabular whitespace-nowrap";

/**
 * A dialog with a form in it. `onSave` resolves to null when it worked, or to
 * the reason it could not be done, which is shown without closing.
 */
export function FormDialog({ open, title, onClose, onSave, children, saveLabel = "Save", onRemove }: { open: boolean; title: string; onClose: () => void; onSave: () => Promise<string | null>; children: ReactNode; saveLabel?: string; onRemove?: () => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const why = await work();
      setError(why);
      if (!why) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      width={520}
      footer={
        <>
          {onRemove && <Button variant="ghost" className="mr-auto hover:!text-danger" disabled={busy} onClick={() => void run(onRemove)}>Remove</Button>}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(onSave)}>{saveLabel}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void run(onSave); }}>
        {children}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Modal>
  );
}
