import type { Account, Books, Id, Job, JobStatus, Project, Session } from "./types";
import { JOB_FLOW } from "./types";

/**
 * The rules of the module, kept apart from the screens: what is allowed, and
 * why not when it is not. Each check returns null when it is fine, or the
 * reason as a sentence to show.
 */

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function checkAccount(books: Books, a: Pick<Account, "id" | "name" | "ownerSharePct" | "taxPct" | "ownerId">): string | null {
  if (!a.name.trim()) return "Give the account a name.";
  if (books.accounts.some((x) => x.id !== a.id && same(x.name, a.name))) return "Another account already has that name.";
  if (!(a.ownerSharePct >= 0 && a.ownerSharePct <= 100)) return "The owner's share is a percentage from 0 to 100.";
  if (!(a.taxPct >= 0 && a.taxPct <= 100)) return "The tax rate is a percentage from 0 to 100.";
  if (a.ownerId && !books.people.some((p) => p.id === a.ownerId && p.owner)) return "Choose an owner from the people marked as owners.";
  return null;
}

/** A project is in one account. The same name may be used in another account, but not twice in the same one. */
export function checkProject(books: Books, p: Pick<Project, "id" | "name" | "accountId">): string | null {
  if (!p.name.trim()) return "Give the project a name.";
  if (!books.accounts.some((a) => a.id === p.accountId)) return "Choose the account this project belongs to.";
  if (books.projects.some((x) => x.id !== p.id && x.accountId === p.accountId && same(x.name, p.name))) return "This account already has a project with that name.";
  return null;
}

/** A job goes to a tasker who is assigned to the account its project is in. */
export function checkJob(books: Books, j: Pick<Job, "title" | "projectId" | "assigneeId" | "rate" | "hours" | "revenue">): string | null {
  if (!j.title.trim()) return "Give the task a title.";
  const project = books.projects.find((p) => p.id === j.projectId);
  if (!project) return "Choose the project this task belongs to.";
  if (j.rate < 0 || j.revenue < 0 || j.hours < 0) return "Amounts and hours cannot be negative.";
  if (j.assigneeId) {
    const person = books.people.find((p) => p.id === j.assigneeId);
    if (!person?.tasker || !person.active) return "Choose an active tasker.";
    const account = books.accounts.find((a) => a.id === project.accountId);
    if (!account?.memberIds.includes(j.assigneeId)) return `${person.name} is not assigned to the account “${account?.name ?? ""}”. Assign them to it first.`;
  }
  return null;
}

/** The statuses a job may move to from where it is, for the person signed in. A tasker works and submits; only the manager approves and pays. */
export function nextStatuses(job: Job, session: Session): JobStatus[] {
  const i = JOB_FLOW.indexOf(job.status);
  if (session.role === "tasker") {
    if (job.assigneeId !== session.personId) return [];
    return job.status === "assigned" ? ["in_progress"] : job.status === "in_progress" ? ["submitted"] : [];
  }
  const out: JobStatus[] = [];
  if (i < JOB_FLOW.length - 1) out.push(JOB_FLOW[i + 1]);
  // the manager can also send work back
  if (job.status === "submitted") out.push("in_progress");
  if (job.status === "approved") out.push("submitted");
  return out;
}

/** What a signed-in tasker may see: the accounts they are assigned to, those accounts' projects, and their own jobs. Nothing of anyone else's money. */
export function visibleTo(books: Books, session: Session): Books {
  if (session.role === "admin") return books;
  const me = session.personId;
  const accounts = books.accounts.filter((a) => a.memberIds.includes(me));
  const ids = new Set(accounts.map((a) => a.id));
  const projects = books.projects.filter((p) => ids.has(p.accountId));
  const jobs = books.jobs.filter((j) => j.assigneeId === me).map((j) => ({ ...j, revenue: 0 }));
  return {
    people: books.people.filter((p) => p.id === me).map((p) => ({ ...p, pin: null })),
    // the split and the tax rate are the owner's and the manager's business
    accounts: accounts.map((a) => ({ ...a, ownerSharePct: 0, taxPct: 0, notes: "", memberIds: a.memberIds.filter((m) => m === me) })),
    projects,
    jobs,
    entries: books.entries.filter((e) => e.kind === "tasker_pay" && e.personId === me),
  };
}

/** Whether removing something would leave other records pointing at nothing. */
export function blockers(books: Books, kind: "person" | "account" | "project", id: Id): string | null {
  if (kind === "person") {
    if (books.accounts.some((a) => a.ownerId === id)) return "This person owns an account. Give the account another owner first.";
    if (books.jobs.some((j) => j.assigneeId === id)) return "This person has tasks. Mark them inactive instead, so the history stays intact.";
    if (books.entries.some((e) => e.personId === id)) return "This person appears in the ledger. Mark them inactive instead.";
  }
  if (kind === "account") {
    if (books.projects.some((p) => p.accountId === id)) return "This account has projects. Move or remove them first, or mark the account inactive.";
    if (books.entries.some((e) => e.accountId === id)) return "This account has ledger entries. Mark it inactive instead.";
  }
  if (kind === "project" && books.jobs.some((j) => j.projectId === id)) return "This project has tasks. Mark it done instead, so the history stays intact.";
  return null;
}
