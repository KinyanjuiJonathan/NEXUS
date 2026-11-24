/**
 * The Accounts module: managing work accounts that belong to different people,
 * the taskers who work on them, the jobs they are given and the money that
 * follows from it.
 *
 * It is self-contained: these types, the rules in `rules.ts` and the sums in
 * `finance.ts` know nothing about the screens, so another interface (a
 * taskers' side, a web front end) can be built on the same foundation.
 * Money is kept in minor units (cents), so sums are exact.
 */

export type Id = string;

/** Someone in the system: an account owner, a tasker, or both. */
export interface Person {
  id: Id;
  name: string;
  /** Owns one or more managed accounts. */
  owner: boolean;
  /** Can be assigned to accounts and given jobs. */
  tasker: boolean;
  contact: string;
  /** Sign-in secret for the taskers' side (salted hash, never the PIN itself). */
  pin: Secret | null;
  active: boolean;
  createdAt: number;
}

/** A salted PBKDF2 hash. */
export interface Secret {
  salt: string;
  hash: string;
}

/** A managed account: it belongs to an owner and has its own profit split and tax rate. */
export interface Account {
  id: Id;
  name: string;
  ownerId: Id | null;
  /** Share of the profit that goes to the owner, in percent; the manager keeps the rest. */
  ownerSharePct: number;
  /** Tax taken off the revenue, in percent. */
  taxPct: number;
  /** ISO 4217 code, e.g. "USD", "KES". */
  currency: string;
  /** Taskers assigned to this account. */
  memberIds: Id[];
  notes: string;
  active: boolean;
  createdAt: number;
}

/** A project lives in exactly one account at a time. Another account may have a project of the same name: that is a separate project. */
export interface Project {
  id: Id;
  accountId: Id;
  name: string;
  status: "active" | "paused" | "done";
  notes: string;
  createdAt: number;
}

export type JobStatus = "assigned" | "in_progress" | "submitted" | "approved" | "paid";
export const JOB_FLOW: JobStatus[] = ["assigned", "in_progress", "submitted", "approved", "paid"];

/** A piece of work given to a tasker at a rate. */
export interface Job {
  id: Id;
  projectId: Id;
  assigneeId: Id | null;
  title: string;
  notes: string;
  /** How the tasker is paid: a fixed amount, or per hour worked. */
  rateType: "fixed" | "hourly";
  /** Cents: the fixed amount, or the amount per hour. */
  rate: number;
  /** Hours worked (hourly jobs). */
  hours: number;
  /** Cents the account earns for this job. */
  revenue: number;
  status: JobStatus;
  dueAt: number | null;
  createdAt: number;
  /** When it was approved: the moment it counts in the books. */
  approvedAt: number | null;
}

export type EntryKind = "income" | "expense" | "tasker_pay" | "owner_payout" | "tax";

/** Money that actually moved: a payment to a tasker, a payout to an owner, tax paid, other income or costs. */
export interface Entry {
  id: Id;
  accountId: Id;
  kind: EntryKind;
  /** Cents, always positive; the kind says which way it went. */
  amount: number;
  /** The tasker paid or the owner paid out, where that applies. */
  personId: Id | null;
  jobId: Id | null;
  note: string;
  at: number;
}

export interface Books {
  people: Person[];
  accounts: Account[];
  projects: Project[];
  jobs: Job[];
  entries: Entry[];
}

export const EMPTY_BOOKS: Books = { people: [], accounts: [], projects: [], jobs: [], entries: [] };

/** Who is signed in to the Accounts area. */
export type Session = { role: "admin" } | { role: "tasker"; personId: Id };

export type RecordKind = "person" | "account" | "project" | "job" | "entry" | "auth";
