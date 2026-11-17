import { AnimatePresence, motion } from "framer-motion";
import { AlarmClock, CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useNexus, nexus } from "@/store";
import type { Toast } from "@/store/store";
import { Button, cx } from "./ui";

const ICON = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <TriangleAlert size={16} />,
  error: <XCircle size={16} />,
  reminder: <AlarmClock size={16} />,
};

const TONE = {
  info: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--danger)",
  reminder: "var(--accent-2)",
};

function ToastCard({ t }: { t: Toast }) {
  const s = nexus();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      role={t.kind === "error" ? "alert" : "status"}
      className={cx("glass-strong rounded-xl shadow-xl w-[340px] overflow-hidden pointer-events-auto")}
    >
      <div className="flex gap-3 p-3.5">
        <span className="mt-0.5 shrink-0" style={{ color: TONE[t.kind] }}>{ICON[t.kind]}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg leading-snug">{t.title}</p>
          {t.body && <p className="text-xs text-fg-2 mt-0.5 break-words">{t.body}</p>}
          {t.reminder && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {[5, 10, 30].map((m) => (
                <Button key={m} size="sm" variant="soft" onClick={() => { void s.snoozeReminder(t.reminder!, m); s.dismissToast(t.id); }}>
                  Snooze {m}m
                </Button>
              ))}
              <Button size="sm" variant="primary" onClick={() => { void s.dismissReminder(t.reminder!); s.dismissToast(t.id); }}>
                Done
              </Button>
            </div>
          )}
          {t.action && (
            <button className="mt-1.5 text-xs font-semibold text-accent hover:underline" onClick={() => { t.action!.run(); s.dismissToast(t.id); }}>
              {t.action.label}
            </button>
          )}
        </div>
        <button aria-label="Dismiss" className="text-muted hover:text-fg h-6 w-6 flex items-center justify-center rounded-md shrink-0" onClick={() => s.dismissToast(t.id)}>
          <X size={14} />
        </button>
      </div>
      <div className="h-0.5" style={{ background: TONE[t.kind], opacity: 0.6 }} />
    </motion.div>
  );
}

export function Toasts({ position = "bottom-right" }: { position?: "bottom-right" | "top" }) {
  const toasts = useNexus((s) => s.toasts);
  return (
    <div className={cx("fixed z-[60] flex flex-col gap-2 pointer-events-none", position === "bottom-right" ? "bottom-4 right-4" : "top-2 left-2 right-2 items-center")}>
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
