import { createStore, type StoreApi } from "zustand/vanilla";
import { checkSecret, makeSecret, pinProblem } from "./auth";
import type { RecordStore } from "./backend";
import { blockers, checkAccount, checkJob, checkProject, nextStatuses } from "./rules";
import { EMPTY_BOOKS, type Account, type Books, type Entry, type Id, type Job, type JobStatus, type Person, type Project, type RecordKind, type Secret, type Session } from "./types";

/**
 * The module's state: the books, who is signed in, and every change that can
 * be made to them. Each change is checked against the rules, saved, and only
 * then shown, so what is on screen is what is stored. A function that cannot
 * do what was asked resolves to the reason as a sentence; null means done.
 */
export interface AccountsState {
  ready: boolean;
  books: Books;
  session: Session | null;
  /** The manager's passcode (the fallback when Windows Hello is not used). */
  adminSecret: Secret | null;

  load(): Promise<void>;
  // signing in
  setAdminPasscode(pin: string): Promise<string | null>;
  signInAdmin(pin: string): Promise<boolean>;
  /** After Windows has verified the user (fingerprint, face or PIN). */
  signInVerified(): void;
  signInTasker(personId: Id, pin: string): Promise<boolean>;
  signOut(): void;

  // the manager's changes
  savePerson(p: Partial<Person> & { name: string }, pin?: string): Promise<string | null>;
  saveAccount(a: Partial<Account> & { name: string }): Promise<string | null>;
  setMember(accountId: Id, personId: Id, member: boolean): Promise<string | null>;
  saveProject(p: Partial<Project> & { name: string; accountId: Id }): Promise<string | null>;
  /** Move a project to another account (it is in one account at a time). */
  moveProject(projectId: Id, accountId: Id): Promise<string | null>;
  /** Give another account the same project: a separate copy with the same name. */
  copyProject(projectId: Id, accountId: Id): Promise<string | null>;
  saveJob(j: Partial<Job> & { title: string; projectId: Id }): Promise<string | null>;
  addEntry(e: Omit<Entry, "id" | "at"> & { at?: number }): Promise<string | null>;
  remove(kind: "person" | "account" | "project" | "job" | "entry", id: Id): Promise<string | null>;

  // open to the tasker for their own jobs, within the rules
  setJobStatus(jobId: Id, status: JobStatus): Promise<string | null>;
  logHours(jobId: Id, hours: number): Promise<string | null>;
}

const LISTS: Record<Exclude<RecordKind, "auth">, keyof Books> = { person: "people", account: "accounts", project: "projects", job: "jobs", entry: "entries" };
const NOT_MANAGER = "Only the manager can do that.";

export function createAccountsStore(records: RecordStore, now: () => number = () => Date.now(), id: () => string = () => crypto.randomUUID()): StoreApi<AccountsState> {
  return createStore<AccountsState>()((set, get) => {
    const admin = () => get().session?.role === "admin";
    /** Save one record and put it in the books. */
    const put = async <K extends Exclude<RecordKind, "auth">>(kind: K, record: Books[(typeof LISTS)[K]][number]) => {
      await records.put(kind, record);
      const list = LISTS[kind];
      const cur = get().books[list] as { id: string }[];
      set({ books: { ...get().books, [list]: cur.some((x) => x.id === record.id) ? cur.map((x) => (x.id === record.id ? record : x)) : [...cur, record] } });
    };

    return {
      ready: false,
      books: EMPTY_BOOKS,
      session: null,
      adminSecret: null,

      async load() {
        const [people, accounts, projects, jobs, entries, auth] = await Promise.all([
          records.list<Person>("person"),
          records.list<Account>("account"),
          records.list<Project>("project"),
          records.list<Job>("job"),
          records.list<Entry>("entry"),
          records.list<{ id: string; secret: Secret }>("auth"),
        ]);
        set({ ready: true, books: { people, accounts, projects, jobs, entries }, adminSecret: auth.find((a) => a.id === "admin")?.secret ?? null });
      },

      async setAdminPasscode(pin) {
        // the first passcode can be set by whoever opens the module; changing it needs the manager
        if (get().adminSecret && !admin()) return NOT_MANAGER;
        const bad = pinProblem(pin);
        if (bad) return bad;
        const secret = await makeSecret(pin);
        await records.put("auth", { id: "admin", secret });
        set({ adminSecret: secret, session: { role: "admin" } });
        return null;
      },
      async signInAdmin(pin) {
        const ok = await checkSecret(pin, get().adminSecret);
        if (ok) set({ session: { role: "admin" } });
        return ok;
      },
      signInVerified: () => set({ session: { role: "admin" } }),
      async signInTasker(personId, pin) {
        const p = get().books.people.find((x) => x.id === personId && x.tasker && x.active);
        const ok = !!p && (await checkSecret(pin, p.pin));
        if (ok) set({ session: { role: "tasker", personId } });
        return ok;
      },
      signOut: () => set({ session: null }),

      async savePerson(p, pin) {
        if (!admin()) return NOT_MANAGER;
        if (!p.name.trim()) return "Give the person a name.";
        const cur = get().books.people.find((x) => x.id === p.id);
        if (get().books.people.some((x) => x.id !== p.id && x.name.trim().toLowerCase() === p.name.trim().toLowerCase())) return "Someone with that name already exists.";
        let secret = cur?.pin ?? null;
        if (pin) {
          const bad = pinProblem(pin);
          if (bad) return bad;
          secret = await makeSecret(pin);
        }
        const next: Person = { id: cur?.id ?? id(), owner: false, tasker: true, contact: "", active: true, createdAt: cur?.createdAt ?? now(), ...cur, ...p, name: p.name.trim(), pin: secret };
        if (!next.owner && !next.tasker) return "Mark the person as an owner, a tasker, or both.";
        await put("person", next);
        return null;
      },

      async saveAccount(a) {
        if (!admin()) return NOT_MANAGER;
        const cur = get().books.accounts.find((x) => x.id === a.id);
        const next: Account = { id: cur?.id ?? id(), ownerId: null, ownerSharePct: 50, taxPct: 0, currency: "USD", memberIds: [], notes: "", active: true, createdAt: cur?.createdAt ?? now(), ...cur, ...a, name: a.name.trim() };
        const bad = checkAccount(get().books, next);
        if (bad) return bad;
        await put("account", next);
        return null;
      },

      async setMember(accountId, personId, member) {
        if (!admin()) return NOT_MANAGER;
        const a = get().books.accounts.find((x) => x.id === accountId);
        const p = get().books.people.find((x) => x.id === personId);
        if (!a || !p) return "That account or person no longer exists.";
        if (member && !p.tasker) return `${p.name} is not marked as a tasker.`;
        if (!member && get().books.jobs.some((j) => j.assigneeId === personId && j.status !== "paid" && get().books.projects.some((pr) => pr.id === j.projectId && pr.accountId === accountId))) {
          return `${p.name} still has unfinished tasks on this account. Reassign or finish them first.`;
        }
        const memberIds = member ? [...new Set([...a.memberIds, personId])] : a.memberIds.filter((m) => m !== personId);
        await put("account", { ...a, memberIds });
        return null;
      },

      async saveProject(p) {
        if (!admin()) return NOT_MANAGER;
        const cur = get().books.projects.find((x) => x.id === p.id);
        const next: Project = { id: cur?.id ?? id(), status: "active", notes: "", createdAt: cur?.createdAt ?? now(), ...cur, ...p, name: p.name.trim() };
        const bad = checkProject(get().books, next);
        if (bad) return bad;
        await put("project", next);
        return null;
      },

      async moveProject(projectId, accountId) {
        if (!admin()) return NOT_MANAGER;
        const p = get().books.projects.find((x) => x.id === projectId);
        if (!p) return "That project no longer exists.";
        if (p.accountId === accountId) return null;
        const next = { ...p, accountId };
        const bad = checkProject(get().books, next);
        if (bad) return bad;
        // its tasks go with it, so their taskers must be on the new account too
        const target = get().books.accounts.find((a) => a.id === accountId)!;
        const missing = get().books.jobs.filter((j) => j.projectId === projectId && j.assigneeId && !target.memberIds.includes(j.assigneeId));
        if (missing.length) {
          const names = [...new Set(missing.map((j) => get().books.people.find((x) => x.id === j.assigneeId)?.name ?? "someone"))].join(", ");
          return `${names} ${missing.length === 1 ? "has a task" : "have tasks"} in this project but ${missing.length === 1 ? "is" : "are"} not assigned to “${target.name}”. Assign them to it first.`;
        }
        await put("project", next);
        return null;
      },

      async copyProject(projectId, accountId) {
        if (!admin()) return NOT_MANAGER;
        const p = get().books.projects.find((x) => x.id === projectId);
        if (!p) return "That project no longer exists.";
        const next: Project = { ...p, id: id(), accountId, status: "active", createdAt: now() };
        const bad = checkProject(get().books, next);
        if (bad) return bad;
        await put("project", next);
        return null;
      },

      async saveJob(j) {
        if (!admin()) return NOT_MANAGER;
        const cur = get().books.jobs.find((x) => x.id === j.id);
        const next: Job = { id: cur?.id ?? id(), assigneeId: null, notes: "", rateType: "fixed", rate: 0, hours: 0, revenue: 0, status: "assigned", dueAt: null, createdAt: cur?.createdAt ?? now(), approvedAt: null, ...cur, ...j, title: j.title.trim() };
        const bad = checkJob(get().books, next);
        if (bad) return bad;
        await put("job", next);
        return null;
      },

      async setJobStatus(jobId, status) {
        const session = get().session;
        const job = get().books.jobs.find((x) => x.id === jobId);
        if (!session || !job) return "That task no longer exists.";
        if (!nextStatuses(job, session).includes(status)) return session.role === "tasker" ? "Only the manager can approve or pay a task." : "A task cannot go to that status from where it is.";
        const approvedNow = (status === "approved" || status === "paid") && job.approvedAt == null;
        await put("job", { ...job, status, approvedAt: approvedNow ? now() : status === "submitted" || status === "in_progress" ? null : job.approvedAt });
        return null;
      },

      async logHours(jobId, hours) {
        const session = get().session;
        const job = get().books.jobs.find((x) => x.id === jobId);
        if (!session || !job) return "That task no longer exists.";
        if (session.role === "tasker" && job.assigneeId !== session.personId) return "That is not your task.";
        if (job.status === "approved" || job.status === "paid") return "Hours cannot be changed once a task is approved.";
        if (!(hours >= 0) || hours > 10_000) return "Enter the hours as a number.";
        await put("job", { ...job, hours: Math.round(hours * 100) / 100 });
        return null;
      },

      async addEntry(e) {
        if (!admin()) return NOT_MANAGER;
        if (!(e.amount > 0)) return "Enter an amount greater than zero.";
        if (!get().books.accounts.some((a) => a.id === e.accountId)) return "Choose the account.";
        if ((e.kind === "tasker_pay" || e.kind === "owner_payout") && !e.personId) return "Choose who was paid.";
        await put("entry", { ...e, id: id(), at: e.at ?? now() });
        return null;
      },

      async remove(kind, rid) {
        if (!admin()) return NOT_MANAGER;
        if (kind !== "job" && kind !== "entry") {
          const why = blockers(get().books, kind, rid);
          if (why) return why;
        }
        if (kind === "job" && get().books.entries.some((e) => e.jobId === rid)) return "A payment in the ledger refers to this task. Remove that entry first.";
        await records.remove(kind, rid);
        const list = LISTS[kind];
        let books = { ...get().books, [list]: (get().books[list] as { id: string }[]).filter((x) => x.id !== rid) } as Books;
        // a removed tasker leaves no dangling assignments behind
        if (kind === "person") {
          for (const a of books.accounts.filter((x) => x.memberIds.includes(rid))) {
            const next = { ...a, memberIds: a.memberIds.filter((m) => m !== rid) };
            await records.put("account", next);
            books = { ...books, accounts: books.accounts.map((x) => (x.id === a.id ? next : x)) };
          }
        }
        set({ books });
        return null;
      },
    };
  });
}
