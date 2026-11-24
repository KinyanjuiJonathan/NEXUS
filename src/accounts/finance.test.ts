import { describe, expect, it } from "vitest";
import type { Account, Books, Entry, Job, Person, Project } from "./types";
import { accountSummary, jobPay, money, monthly, parseMoney, taskerBalances, totals } from "./finance";
import { blockers, checkAccount, checkJob, checkProject, nextStatuses, visibleTo } from "./rules";

const person = (id: string, o: Partial<Person> = {}): Person => ({ id, name: id, owner: false, tasker: true, contact: "", pin: null, active: true, createdAt: 0, ...o });
const account = (id: string, o: Partial<Account> = {}): Account => ({ id, name: id, ownerId: null, ownerSharePct: 40, taxPct: 16, currency: "USD", memberIds: [], notes: "", active: true, createdAt: 0, ...o });
const project = (id: string, accountId: string, o: Partial<Project> = {}): Project => ({ id, accountId, name: id, status: "active", notes: "", createdAt: 0, ...o });
const job = (id: string, projectId: string, o: Partial<Job> = {}): Job => ({ id, projectId, assigneeId: null, title: id, notes: "", rateType: "fixed", rate: 0, hours: 0, revenue: 0, status: "assigned", dueAt: null, createdAt: 0, approvedAt: null, ...o });
const entry = (id: string, accountId: string, kind: Entry["kind"], amount: number, o: Partial<Entry> = {}): Entry => ({ id, accountId, kind, amount, personId: null, jobId: null, note: "", at: 10, ...o });

/** Two owners, three accounts with different splits and tax, two taskers. */
const BOOKS: Books = {
  people: [person("amina", { owner: true, tasker: false }), person("brian", { owner: true, tasker: false }), person("tess"), person("omar")],
  accounts: [
    account("upwork-amina", { ownerId: "amina", ownerSharePct: 40, taxPct: 16, memberIds: ["tess", "omar"] }),
    account("fiverr-amina", { ownerId: "amina", ownerSharePct: 50, taxPct: 0, memberIds: ["tess"] }),
    account("upwork-brian", { ownerId: "brian", ownerSharePct: 30, taxPct: 10, currency: "KES", memberIds: ["omar"] }),
  ],
  projects: [project("site", "upwork-amina"), project("logo", "fiverr-amina"), project("site-kes", "upwork-brian", { name: "site" })],
  jobs: [
    job("j1", "site", { assigneeId: "tess", rate: 20_000, revenue: 100_000, status: "approved", approvedAt: 5 }), // fixed 200.00, earns 1,000.00
    job("j2", "site", { assigneeId: "omar", rateType: "hourly", rate: 1_500, hours: 10, revenue: 50_000, status: "paid", approvedAt: 6 }), // 15.00 × 10 h
    job("j3", "site", { assigneeId: "tess", rate: 9_000, revenue: 30_000, status: "submitted" }), // not approved yet: not in the books
    job("j4", "logo", { assigneeId: "tess", rate: 5_000, revenue: 20_000, status: "approved", approvedAt: 7 }),
    job("j5", "site-kes", { assigneeId: "omar", rate: 300_000, revenue: 1_000_000, status: "approved", approvedAt: 8 }),
  ],
  entries: [
    entry("e1", "upwork-amina", "tasker_pay", 15_000, { personId: "omar", jobId: "j2" }),
    entry("e2", "upwork-amina", "tax", 10_000),
    entry("e3", "upwork-amina", "owner_payout", 20_000, { personId: "amina" }),
    entry("e4", "upwork-amina", "expense", 4_000, { note: "connects" }),
    entry("e5", "fiverr-amina", "income", 1_000, { note: "tip" }),
  ],
};

describe("the books of an account", () => {
  it("splits what approved work earned into tax, costs, the owner's share and the manager's", () => {
    const s = accountSummary(BOOKS, BOOKS.accounts[0]);
    expect(s.revenue).toBe(150_000); // j1 + j2; j3 is not approved
    expect(s.tax).toBe(24_000); // 16 %
    expect(s.taskerCost).toBe(35_000); // 200.00 + 15.00 × 10
    expect(s.expenses).toBe(4_000);
    expect(s.profit).toBe(87_000);
    expect(s.ownerShare).toBe(34_800); // 40 %
    expect(s.managerShare).toBe(52_200);
    expect(s.ownerShare + s.managerShare).toBe(s.profit); // nothing lost to rounding
    // what is still owed after the payments in the ledger
    expect([s.taxDue, s.ownerDue, s.taskerDue]).toEqual([14_000, 14_800, 20_000]);
    expect(s.jobs).toEqual({ open: 0, awaitingApproval: 1, approved: 2 });
  });

  it("gives each account its own split and tax, even for the same owner", () => {
    const fiverr = accountSummary(BOOKS, BOOKS.accounts[1]);
    expect(fiverr).toMatchObject({ revenue: 21_000, tax: 0, taskerCost: 5_000, profit: 16_000, ownerShare: 8_000, managerShare: 8_000 });
    const brian = accountSummary(BOOKS, BOOKS.accounts[2]);
    expect(brian).toMatchObject({ currency: "KES", revenue: 1_000_000, tax: 100_000, profit: 600_000, ownerShare: 180_000, managerShare: 420_000 });
  });

  it("shares a loss with nobody: the owner gets nothing and the manager carries it", () => {
    const books = { ...BOOKS, jobs: [job("x", "site", { assigneeId: "tess", rate: 50_000, revenue: 10_000, status: "approved", approvedAt: 1 })], entries: [] };
    expect(accountSummary(books, BOOKS.accounts[0])).toMatchObject({ profit: -41_600, ownerShare: 0, managerShare: -41_600 });
  });

  it("can be asked for a period", () => {
    const early = accountSummary(BOOKS, BOOKS.accounts[0], { from: 0, to: 6 });
    expect(early.revenue).toBe(100_000); // only j1 was approved before 6
    expect(early.taskerPaid).toBe(0); // the ledger entries are at 10
  });

  it("adds accounts up per currency and never mixes currencies", () => {
    const t = totals(BOOKS.accounts.map((a) => accountSummary(BOOKS, a)));
    expect(t.map((x) => x.currency)).toEqual(["KES", "USD"]);
    expect(t.find((x) => x.currency === "USD")).toMatchObject({ revenue: 171_000, managerShare: 60_200, ownerShare: 42_800 });
  });

  it("knows what each tasker earned, was paid and is owed", () => {
    const b = taskerBalances(BOOKS);
    const row = (id: string, c: string) => b.find((r) => r.personId === id && r.currency === c)!;
    expect(row("tess", "USD")).toMatchObject({ earned: 25_000, paid: 0, due: 25_000, pending: 9_000, jobs: 2 });
    expect(row("omar", "USD")).toMatchObject({ earned: 15_000, paid: 15_000, due: 0 });
    expect(row("omar", "KES")).toMatchObject({ earned: 300_000, due: 300_000 });
    expect(jobPay(BOOKS.jobs[1])).toBe(15_000);
  });

  it("builds a monthly trend and formats money", () => {
    const now = Date.UTC(2026, 10, 24);
    const books = { ...BOOKS, jobs: [job("m", "site", { revenue: 100_000, rate: 10_000, status: "approved", approvedAt: Date.UTC(2026, 9, 12) })], entries: [] };
    const trend = monthly(books, 3, now, "USD");
    expect(trend).toHaveLength(3);
    expect(trend.slice(1).map((m) => m.label)).toEqual(["Oct", "Nov"]);
    expect(trend[1].revenue).toBe(100_000);
    expect(trend[2].revenue).toBe(0);
    expect(money(125_050, "USD")).toContain("1,250.50");
    expect(parseMoney("1,250.50")).toBe(125_050);
    expect(parseMoney("abc")).toBeNull();
  });
});

describe("the rules", () => {
  it("a project is in one account; the same name may exist in another account, not twice in one", () => {
    expect(checkProject(BOOKS, { id: "new", name: "Site", accountId: "upwork-amina" })).toMatch(/already has a project/);
    expect(checkProject(BOOKS, { id: "new", name: "site", accountId: "fiverr-amina" })).toBeNull(); // another account can have it too
    expect(checkProject(BOOKS, { id: "site", name: "site", accountId: "upwork-amina" })).toBeNull(); // itself
    expect(checkProject(BOOKS, { id: "new", name: " ", accountId: "upwork-amina" })).toMatch(/name/);
    expect(checkProject(BOOKS, { id: "new", name: "x", accountId: "nowhere" })).toMatch(/account/);
  });

  it("accounts need a unique name and sensible rates", () => {
    expect(checkAccount(BOOKS, { id: "n", name: "Upwork-Amina", ownerSharePct: 40, taxPct: 10, ownerId: "amina" })).toMatch(/already has that name/);
    expect(checkAccount(BOOKS, { id: "n", name: "new", ownerSharePct: 140, taxPct: 10, ownerId: null })).toMatch(/share/);
    expect(checkAccount(BOOKS, { id: "n", name: "new", ownerSharePct: 40, taxPct: -1, ownerId: null })).toMatch(/tax/);
    expect(checkAccount(BOOKS, { id: "n", name: "new", ownerSharePct: 40, taxPct: 10, ownerId: "tess" })).toMatch(/owner/); // tess is a tasker, not an owner
    expect(checkAccount(BOOKS, { id: "n", name: "new", ownerSharePct: 40, taxPct: 10, ownerId: "amina" })).toBeNull();
  });

  it("a task goes to a tasker assigned to the project's account", () => {
    const base = { title: "Fix header", projectId: "logo", rate: 1000, hours: 0, revenue: 5000 };
    expect(checkJob(BOOKS, { ...base, assigneeId: "tess" })).toBeNull();
    expect(checkJob(BOOKS, { ...base, assigneeId: "omar" })).toMatch(/not assigned to the account/); // omar is not on the Fiverr account
    expect(checkJob(BOOKS, { ...base, assigneeId: "amina" })).toMatch(/active tasker/);
    expect(checkJob(BOOKS, { ...base, assigneeId: null })).toBeNull(); // may be left unassigned
    expect(checkJob(BOOKS, { ...base, title: "", assigneeId: null })).toMatch(/title/);
  });

  it("a tasker works and submits; only the manager approves and pays", () => {
    const j = BOOKS.jobs[2]; // submitted, tess
    expect(nextStatuses({ ...j, status: "assigned" }, { role: "tasker", personId: "tess" })).toEqual(["in_progress"]);
    expect(nextStatuses({ ...j, status: "in_progress" }, { role: "tasker", personId: "tess" })).toEqual(["submitted"]);
    expect(nextStatuses(j, { role: "tasker", personId: "tess" })).toEqual([]); // cannot approve their own work
    expect(nextStatuses({ ...j, status: "assigned" }, { role: "tasker", personId: "omar" })).toEqual([]); // not theirs
    expect(nextStatuses(j, { role: "admin" })).toEqual(["approved", "in_progress"]);
  });

  it("a tasker sees their own work and pay, and nobody else's money", () => {
    const mine = visibleTo(BOOKS, { role: "tasker", personId: "tess" });
    expect(mine.accounts.map((a) => a.id)).toEqual(["upwork-amina", "fiverr-amina"]);
    expect(mine.jobs.map((j) => j.id)).toEqual(["j1", "j3", "j4"]);
    expect(mine.jobs.every((j) => j.revenue === 0)).toBe(true); // what the account earns is not theirs to see
    expect(mine.accounts.every((a) => a.ownerSharePct === 0 && a.taxPct === 0)).toBe(true);
    expect(mine.people.map((p) => p.id)).toEqual(["tess"]);
    expect(mine.entries).toEqual([]); // only payments made to them
    expect(visibleTo(BOOKS, { role: "tasker", personId: "omar" }).entries.map((e) => e.id)).toEqual(["e1"]);
    expect(visibleTo(BOOKS, { role: "admin" })).toBe(BOOKS);
  });

  it("refuses to remove what the history depends on", () => {
    expect(blockers(BOOKS, "person", "amina")).toMatch(/owns an account/);
    expect(blockers(BOOKS, "person", "tess")).toMatch(/has tasks/);
    expect(blockers(BOOKS, "account", "upwork-amina")).toMatch(/has projects/);
    expect(blockers(BOOKS, "project", "site")).toMatch(/has tasks/);
    expect(blockers({ ...BOOKS, jobs: [] }, "project", "site")).toBeNull();
  });
});
