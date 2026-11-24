import type { Account, Books, Entry, Id, Job } from "./types";

/**
 * The sums. Everything here is a pure function of the books, so every screen
 * (and any future interface) shows the same figures.
 *
 * For one account:
 *   revenue  = what approved jobs earned + other income
 *   tax      = revenue × the account's tax rate
 *   costs    = what the taskers earned on approved jobs + other expenses
 *   profit   = revenue − tax − costs
 *   owner    = profit × the owner's share (nothing when there is a loss)
 *   manager  = profit − owner
 * A job counts once it is approved. Balances are what is owed minus what the
 * ledger says has been paid.
 */

/** What the tasker earns for a job, in cents. */
export function jobPay(j: Job): number {
  return j.rateType === "hourly" ? Math.round(j.rate * Math.max(0, j.hours)) : j.rate;
}

export const counts = (j: Job) => j.status === "approved" || j.status === "paid";

export interface Period {
  from?: number;
  to?: number;
}
const within = (at: number | null, p: Period) => at != null && (p.from == null || at >= p.from) && (p.to == null || at < p.to);

export interface AccountSummary {
  accountId: Id;
  currency: string;
  revenue: number;
  tax: number;
  taskerCost: number;
  expenses: number;
  profit: number;
  ownerShare: number;
  managerShare: number;
  /** Paid according to the ledger. */
  taxPaid: number;
  ownerPaid: number;
  taskerPaid: number;
  /** Still owed. */
  taxDue: number;
  ownerDue: number;
  taskerDue: number;
  jobs: { open: number; awaitingApproval: number; approved: number };
}

const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);
const sum = (entries: Entry[], kind: Entry["kind"]) => entries.reduce((a, e) => a + (e.kind === kind ? e.amount : 0), 0);

/** The books of one account, optionally for a period (jobs by approval date, ledger entries by their date). */
export function accountSummary(books: Books, account: Account, period: Period = {}): AccountSummary {
  const projectIds = new Set(books.projects.filter((p) => p.accountId === account.id).map((p) => p.id));
  const all = books.jobs.filter((j) => projectIds.has(j.projectId));
  const earned = all.filter((j) => counts(j) && within(j.approvedAt ?? j.createdAt, period));
  const entries = books.entries.filter((e) => e.accountId === account.id && within(e.at, period));
  const revenue = earned.reduce((a, j) => a + j.revenue, 0) + sum(entries, "income");
  const tax = pct(revenue, account.taxPct);
  const taskerCost = earned.reduce((a, j) => a + jobPay(j), 0);
  const expenses = sum(entries, "expense");
  const profit = revenue - tax - taskerCost - expenses;
  const ownerShare = profit > 0 ? pct(profit, account.ownerSharePct) : 0;
  const taxPaid = sum(entries, "tax");
  const ownerPaid = sum(entries, "owner_payout");
  const taskerPaid = sum(entries, "tasker_pay");
  return {
    accountId: account.id,
    currency: account.currency,
    revenue,
    tax,
    taskerCost,
    expenses,
    profit,
    ownerShare,
    managerShare: profit - ownerShare,
    taxPaid,
    ownerPaid,
    taskerPaid,
    taxDue: tax - taxPaid,
    ownerDue: ownerShare - ownerPaid,
    taskerDue: taskerCost - taskerPaid,
    jobs: {
      open: all.filter((j) => j.status === "assigned" || j.status === "in_progress").length,
      awaitingApproval: all.filter((j) => j.status === "submitted").length,
      approved: all.filter(counts).length,
    },
  };
}

export interface TaskerBalance {
  personId: Id;
  currency: string;
  /** Earned on approved jobs. */
  earned: number;
  paid: number;
  due: number;
  /** Work in hand: jobs not yet approved, at their agreed pay. */
  pending: number;
  jobs: number;
}

/** What each tasker has earned and is still owed, per currency (accounts can be in different currencies). */
export function taskerBalances(books: Books, period: Period = {}): TaskerBalance[] {
  const accountOf = new Map(books.projects.map((p) => [p.id, p.accountId]));
  const currencyOf = new Map(books.accounts.map((a) => [a.id, a.currency]));
  const rows = new Map<string, TaskerBalance>();
  const row = (personId: Id, currency: string) => {
    const key = `${personId}|${currency}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { personId, currency, earned: 0, paid: 0, due: 0, pending: 0, jobs: 0 }));
    return r;
  };
  for (const j of books.jobs) {
    if (!j.assigneeId) continue;
    const currency = currencyOf.get(accountOf.get(j.projectId) ?? "") ?? "USD";
    const r = row(j.assigneeId, currency);
    if (counts(j)) {
      if (within(j.approvedAt ?? j.createdAt, period)) {
        r.earned += jobPay(j);
        r.jobs += 1;
      }
    } else r.pending += jobPay(j);
  }
  for (const e of books.entries) {
    if (e.kind !== "tasker_pay" || !e.personId || !within(e.at, period)) continue;
    row(e.personId, currencyOf.get(e.accountId) ?? "USD").paid += e.amount;
  }
  for (const r of rows.values()) r.due = r.earned - r.paid;
  return [...rows.values()].sort((a, b) => b.due - a.due);
}

export interface Totals {
  currency: string;
  revenue: number;
  tax: number;
  taskerCost: number;
  expenses: number;
  profit: number;
  ownerShare: number;
  managerShare: number;
  taxDue: number;
  ownerDue: number;
  taskerDue: number;
}

/** Every account added up, one line per currency (different currencies are never mixed). */
export function totals(summaries: AccountSummary[]): Totals[] {
  const by = new Map<string, Totals>();
  for (const s of summaries) {
    let t = by.get(s.currency);
    if (!t) by.set(s.currency, (t = { currency: s.currency, revenue: 0, tax: 0, taskerCost: 0, expenses: 0, profit: 0, ownerShare: 0, managerShare: 0, taxDue: 0, ownerDue: 0, taskerDue: 0 }));
    for (const k of ["revenue", "tax", "taskerCost", "expenses", "profit", "ownerShare", "managerShare", "taxDue", "ownerDue", "taskerDue"] as const) t[k] += s[k];
  }
  return [...by.values()].sort((a, b) => b.revenue - a.revenue);
}

/** Revenue and the manager's share per calendar month (UTC), oldest first, for the trend chart. */
export function monthly(books: Books, months: number, now: number, currency: string): { label: string; revenue: number; managerShare: number }[] {
  const d = new Date(now);
  const out: { label: string; revenue: number; managerShare: number }[] = [];
  const accounts = books.accounts.filter((a) => a.currency === currency);
  for (let i = months - 1; i >= 0; i--) {
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1);
    const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1);
    let revenue = 0;
    let managerShare = 0;
    for (const a of accounts) {
      const s = accountSummary(books, a, { from, to });
      revenue += s.revenue;
      managerShare += s.managerShare;
    }
    out.push({ label: new Date(from).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }), revenue, managerShare });
  }
  return out;
}

/** "1,250.00 USD" style money, from cents. */
export function money(cents: number, currency: string): string {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "code" }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Cents from what the user typed ("1,250.50" → 125050); null when it is not a number. */
export function parseMoney(text: string): number | null {
  const n = Number(String(text).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
