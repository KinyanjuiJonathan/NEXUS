import { describe, expect, it } from "vitest";
import { memoryRecords } from "./backend";
import { accountSummary, taskerBalances } from "./finance";
import { createAccountsStore } from "./store";

async function setup() {
  const kv = new Map<string, string>();
  const records = memoryRecords(kv as never);
  let seq = 0;
  let t = 1000;
  const make = () => createAccountsStore(records, () => (t += 10), () => `id${++seq}`);
  const store = make();
  await store.getState().load();
  const s = () => store.getState();
  const find = { person: (n: string) => s().books.people.find((p) => p.name === n)!, account: (n: string) => s().books.accounts.find((a) => a.name === n)!, project: (n: string, acc: string) => s().books.projects.find((p) => p.name === n && p.accountId === find.account(acc).id)!, job: (n: string) => s().books.jobs.find((j) => j.title === n)! };
  return { store, s, make, find };
}

describe("managing accounts", () => {
  it("is locked until someone signs in, and the first passcode makes the manager", async () => {
    const { s } = await setup();
    expect(s().session).toBeNull();
    expect(await s().saveAccount({ name: "Upwork · Amina" })).toMatch(/Only the manager/);
    expect(await s().setAdminPasscode("12")).toMatch(/at least 4/);
    expect(await s().setAdminPasscode("2468")).toBeNull();
    expect(s().session).toEqual({ role: "admin" });
    s().signOut();
    expect(await s().signInAdmin("0000")).toBe(false);
    expect(s().session).toBeNull();
    expect(await s().signInAdmin("2468")).toBe(true);
    // the passcode itself is never stored
    expect(JSON.stringify(s().adminSecret)).not.toContain("2468");
    // Windows Hello: Windows has already verified the user
    s().signOut();
    s().signInVerified();
    expect(s().session).toEqual({ role: "admin" });
  });

  it("runs the whole flow: owners, accounts with their own split and tax, taskers, projects, tasks, payments", async () => {
    const { s, find, make } = await setup();
    await s().setAdminPasscode("2468");
    expect(await s().savePerson({ name: "Amina", owner: true, tasker: false })).toBeNull();
    expect(await s().savePerson({ name: "Tess", tasker: true }, "7777")).toBeNull();
    expect(await s().savePerson({ name: "Omar", tasker: true }, "8888")).toBeNull();
    expect(await s().savePerson({ name: "tess" })).toMatch(/already exists/);

    // one owner, two accounts, different names, shares and tax
    expect(await s().saveAccount({ name: "Upwork · Amina", ownerId: find.person("Amina").id, ownerSharePct: 40, taxPct: 16 })).toBeNull();
    expect(await s().saveAccount({ name: "Fiverr · Amina", ownerId: find.person("Amina").id, ownerSharePct: 50, taxPct: 0 })).toBeNull();
    expect(await s().saveAccount({ name: "upwork · amina" })).toMatch(/already has that name/);

    // assign taskers; a tasker can be on several accounts
    const up = find.account("Upwork · Amina").id;
    const fv = find.account("Fiverr · Amina").id;
    expect(await s().setMember(up, find.person("Tess").id, true)).toBeNull();
    expect(await s().setMember(fv, find.person("Tess").id, true)).toBeNull();
    expect(await s().setMember(up, find.person("Amina").id, true)).toMatch(/not marked as a tasker/);

    // a project is in one account; another account can get the same project
    expect(await s().saveProject({ name: "Website", accountId: up })).toBeNull();
    expect(await s().saveProject({ name: "website", accountId: up })).toMatch(/already has a project/);
    expect(await s().copyProject(find.project("Website", "Upwork · Amina").id, fv)).toBeNull();
    expect(s().books.projects.filter((p) => p.name === "Website")).toHaveLength(2);

    // tasks at a rate, only for taskers on that account
    const site = find.project("Website", "Upwork · Amina").id;
    expect(await s().saveJob({ title: "Build landing page", projectId: site, assigneeId: find.person("Omar").id, rate: 20_000, revenue: 100_000 })).toMatch(/not assigned to the account/);
    expect(await s().saveJob({ title: "Build landing page", projectId: site, assigneeId: find.person("Tess").id, rate: 20_000, revenue: 100_000 })).toBeNull();
    expect(await s().saveJob({ title: "Support", projectId: site, assigneeId: find.person("Tess").id, rateType: "hourly", rate: 1_500, revenue: 40_000 })).toBeNull();

    // the tasker signs in, works and submits; cannot approve or see the account's money
    s().signOut();
    expect(await s().signInTasker(find.person("Tess").id, "0000")).toBe(false);
    expect(await s().signInTasker(find.person("Tess").id, "7777")).toBe(true);
    const page = find.job("Build landing page").id;
    const support = find.job("Support").id;
    expect(await s().setJobStatus(page, "in_progress")).toBeNull();
    expect(await s().setJobStatus(page, "submitted")).toBeNull();
    expect(await s().setJobStatus(page, "approved")).toMatch(/Only the manager/);
    expect(await s().logHours(support, 6)).toBeNull();
    expect(await s().saveJob({ title: "Sneaky", projectId: site })).toMatch(/Only the manager/);
    expect(await s().addEntry({ accountId: up, kind: "tasker_pay", amount: 1, personId: find.person("Tess").id, jobId: null, note: "" })).toMatch(/Only the manager/);

    // the manager approves and pays
    s().signOut();
    await s().signInAdmin("2468");
    expect(await s().setJobStatus(page, "approved")).toBeNull();
    expect(find.job("Build landing page").approvedAt).not.toBeNull();
    expect(await s().logHours(page, 3)).toMatch(/once a task is approved/);
    expect(await s().addEntry({ accountId: up, kind: "tasker_pay", amount: 20_000, personId: find.person("Tess").id, jobId: page, note: "" })).toBeNull();
    const sum = accountSummary(s().books, find.account("Upwork · Amina"));
    expect(sum).toMatchObject({ revenue: 100_000, tax: 16_000, taskerCost: 20_000, profit: 64_000, ownerShare: 25_600, managerShare: 38_400, taskerDue: 0 });
    expect(taskerBalances(s().books).find((b) => b.personId === find.person("Tess").id)).toMatchObject({ earned: 20_000, paid: 20_000, due: 0, pending: 9_000 }); // 15.00 × 6 h still in hand

    // history is protected
    expect(await s().remove("person", find.person("Tess").id)).toMatch(/has tasks/);
    expect(await s().remove("job", page)).toMatch(/payment in the ledger/);
    expect(await s().setMember(up, find.person("Tess").id, false)).toMatch(/unfinished tasks/);

    // everything is still there after a restart, and the session is not
    const again = make();
    await again.getState().load();
    expect(again.getState().session).toBeNull();
    expect(again.getState().books.accounts.map((a) => a.name).sort()).toEqual(["Fiverr · Amina", "Upwork · Amina"]);
    expect(accountSummary(again.getState().books, again.getState().books.accounts.find((a) => a.name === "Upwork · Amina")!).managerShare).toBe(38_400);
    expect(await again.getState().signInAdmin("2468")).toBe(true);
  });

  it("moves a project to another account only when its taskers are on that account", async () => {
    const { s, find } = await setup();
    await s().setAdminPasscode("2468");
    await s().savePerson({ name: "Tess" }, "7777");
    await s().saveAccount({ name: "A" });
    await s().saveAccount({ name: "B" });
    const [a, b] = [find.account("A").id, find.account("B").id];
    await s().setMember(a, find.person("Tess").id, true);
    await s().saveProject({ name: "Website", accountId: a });
    const pid = find.project("Website", "A").id;
    await s().saveJob({ title: "Task", projectId: pid, assigneeId: find.person("Tess").id, rate: 100 });
    expect(await s().moveProject(pid, b)).toMatch(/not assigned to “B”/);
    await s().setMember(b, find.person("Tess").id, true);
    expect(await s().moveProject(pid, b)).toBeNull();
    expect(s().books.projects.find((p) => p.id === pid)!.accountId).toBe(b); // in one account at a time
    expect(s().books.projects).toHaveLength(1);
  });
});
