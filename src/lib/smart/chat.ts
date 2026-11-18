import { create } from "zustand";
import { nexus } from "@/store";
import { applyTurnWithIds, turnEnv } from "./apply";
import { EMPTY_CONTEXT, planTurn, type ConvContext, type Line, type Question } from "./converse";

/**
 * The AI Schedule conversation: what was said, what NEXUS did, and what the
 * conversation is about (so "it" and "my meeting" keep their meaning). Kept
 * while the panel is closed and across restarts; the schedule itself lives in
 * the main store, never here.
 */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  at: number;
  text?: string;
  lines?: Line[];
  question?: Question | null;
  /** The option picked for `question`, once answered. */
  answered?: string;
}

interface Pending {
  text: string;
  answers: Record<string, string>;
}

interface SchedulerState {
  open: boolean;
  /** Text typed or dictated but not sent yet. */
  draft: string;
  messages: ChatMessage[];
  context: ConvContext;
  pending: Pending | null;
  busy: boolean;
  setOpen(open: boolean): void;
  setDraft(draft: string): void;
  send(text?: string): Promise<void>;
  answer(value: string, label: string): Promise<void>;
  clear(): void;
}

const KEY = "nexus.scheduler";
const KEEP = 40;

function load(): Pick<SchedulerState, "draft" | "messages" | "context"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && Array.isArray(raw.messages)) {
      return {
        draft: typeof raw.draft === "string" ? raw.draft : "",
        // an unanswered question can't be resumed after a restart
        messages: raw.messages.slice(-KEEP).map((m: ChatMessage) => (m.question && !m.answered ? { ...m, question: null } : m)),
        context: raw.context?.recent ? raw.context : EMPTY_CONTEXT,
      };
    }
  } catch {
    /* start fresh */
  }
  return { draft: "", messages: [], context: EMPTY_CONTEXT };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const save = (s: SchedulerState) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ draft: s.draft, messages: s.messages.slice(-KEEP), context: s.context }));
    } catch {
      /* storage unavailable: the conversation still works for this session */
    }
  }, 300);
};

let n = 0;
const id = () => `m${Date.now().toString(36)}${(n++).toString(36)}`;

export const useScheduler = create<SchedulerState>((set, get) => {
  const push = (m: Omit<ChatMessage, "id" | "at">) => set({ messages: [...get().messages, { ...m, id: id(), at: Date.now() }].slice(-KEEP) });

  /** Plan the message against the calendar as it is now, then either ask or act. */
  const run = async (text: string, answers: Record<string, string>) => {
    set({ busy: true });
    try {
      const now = Date.now();
      const turn = planTurn(text, turnEnv(nexus(), now), get().context, answers);
      if (turn.question) {
        set({ pending: { text, answers } });
        push({ role: "assistant", lines: turn.lines, question: turn.question });
        return;
      }
      const { context, ids } = await applyTurnWithIds(turn, nexus(), get().context);
      const lines = turn.lines.map((l) => (l.ref && ids[l.ref] ? { ...l, ref: ids[l.ref].id } : l));
      set({ context, pending: null });
      push({ role: "assistant", lines });
    } catch (e) {
      set({ pending: null });
      push({ role: "assistant", lines: [{ kind: "problem", title: "That didn't work", note: String(e instanceof Error ? e.message : e) }] });
    } finally {
      set({ busy: false });
      save(get());
    }
  };

  return {
    open: false,
    busy: false,
    pending: null,
    ...load(),
    setOpen: (open) => set({ open }),
    setDraft: (draft) => {
      set({ draft });
      save(get());
    },
    send: async (given) => {
      const text = (given ?? get().draft).trim();
      if (!text || get().busy) return;
      // a new message replaces any question still waiting
      set({ draft: "", pending: null, messages: get().messages.map((m) => (m.question && !m.answered ? { ...m, question: null } : m)) });
      push({ role: "user", text });
      await run(text, {});
    },
    answer: async (value, label) => {
      const pending = get().pending;
      const msgs = get().messages;
      const last = [...msgs].reverse().find((m) => m.question && !m.answered);
      if (!pending || !last?.question || get().busy) return;
      set({ messages: msgs.map((m) => (m.id === last.id ? { ...m, answered: label } : m)) });
      await run(pending.text, { ...pending.answers, [last.question.key]: value });
    },
    clear: () => {
      set({ messages: [], context: EMPTY_CONTEXT, pending: null });
      save(get());
    },
  };
});
