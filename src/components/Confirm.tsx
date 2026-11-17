import { create } from "zustand";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, Modal } from "./ui";

export interface Choice {
  value: string;
  label: string;
  variant?: "primary" | "danger" | "soft";
}

interface ChoiceReq {
  title: string;
  body: ReactNode;
  danger?: boolean;
  choices: Choice[];
  resolve: (value: string | null) => void;
}

const useConfirmStore = create<{ req: ChoiceReq | null; set: (r: ChoiceReq | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

/** Multi-option dialog. Resolves to the chosen value, or null when cancelled. */
export function choose(opts: Omit<ChoiceReq, "resolve">): Promise<string | null> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...opts, resolve }));
}

/** Promise-based confirmation dialog: `if (await confirm({...})) …` */
export async function confirm(opts: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  const r = await choose({
    title: opts.title,
    body: opts.body,
    danger: opts.danger,
    choices: [{ value: "ok", label: opts.confirmLabel ?? "Confirm", variant: opts.danger ? "danger" : "primary" }],
  });
  return r === "ok";
}

export function ConfirmHost() {
  const { req, set } = useConfirmStore();
  const close = (v: string | null) => {
    req?.resolve(v);
    set(null);
  };
  return (
    <Modal
      open={!!req}
      onClose={() => close(null)}
      title={req?.title ?? ""}
      width={480}
      icon={req?.danger ? <TriangleAlert size={18} className="text-warning" /> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>Cancel</Button>
          {req?.choices.map((c, i) => (
            <Button key={c.value} variant={c.variant ?? "primary"} onClick={() => close(c.value)} autoFocus={i === req.choices.length - 1}>
              {c.label}
            </Button>
          ))}
        </>
      }
    >
      <div className="text-sm text-fg-2 leading-relaxed">{req?.body}</div>
    </Modal>
  );
}
