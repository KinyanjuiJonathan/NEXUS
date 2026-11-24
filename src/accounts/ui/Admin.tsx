import { useMemo, useState } from "react";
import { ArrowRightLeft, Banknote, Building2, ClipboardList, Copy, LineChart, Pencil, Plus, Trash2, Users } from "lucide-react";
import { BarChart } from "@/components/Charts";
import { Button, Card, CardHeader, EmptyState, Field, Input, Segmented, Select, Toggle, cx } from "@/components/ui";
import { accountSummary, jobPay, money, monthly, parseMoney, taskerBalances, totals } from "../finance";
import { nextStatuses } from "../rules";
import type { Account, EntryKind, Job, JobStatus, Person, Project } from "../types";
import { accounts, useAccounts } from "../useAccounts";
import { JOB_STATUS } from "./Tasker";
import { Figure, FormDialog, Pill, Table, num, td } from "./parts";

type Tab = "overview" | "accounts" | "people" | "work" | "ledger";
const CURRENCIES = ["USD", "KES", "EUR", "GBP", "AUD", "CAD", "UGX", "TZS", "NGN", "ZAR", "INR"];
const cents = (v: number) => (v / 100).toString();
const NEXT_LABEL: Record<JobStatus, string> = { assigned: "Reset", in_progress: "Send back", submitted: "Unapprove", approved: "Approve", paid: "Mark paid" };

// ------------------------------------------------------------------ overview

function Overview() {
  const books = useAccounts((s) => s.books);
  const summaries = useMemo(() => books.accounts.map((a) => accountSummary(books, a)), [books]);
  const all = useMemo(() => totals(summaries), [summaries]);
  const balances = useMemo(() => taskerBalances(books), [books]);
  const [currency, setCurrency] = useState<string | null>(null);
  const cur = currency ?? all[0]?.currency ?? "USD";
  const trend = useMemo(() => monthly(books, 6, Date.now(), cur), [books, cur]);
  const name = (id: string | null) => books.people.find((p) => p.id === id)?.name ?? "—";

  if (!books.accounts.length) return <Card><EmptyState icon={<Building2 size={22} />} title="No accounts yet" body="Add the people first (owners and taskers), then the accounts they own, under the tabs above." /></Card>;

  return (
    <div className="flex flex-col gap-4">
      {all.map((t) => (
        <Card key={t.currency}>
          <CardHeader title={`All accounts · ${t.currency}`} icon={<LineChart size={16} />} subtitle="Approved work, to date" />
          <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
            <Figure label="Revenue" value={money(t.revenue, t.currency)} />
            <Figure label="Tax" value={money(t.tax, t.currency)} />
            <Figure label="Taskers" value={money(t.taskerCost, t.currency)} hint="What taskers earned on approved tasks" />
            <Figure label="Profit" value={money(t.profit, t.currency)} tone={t.profit < 0 ? "var(--danger)" : undefined} />
            <Figure label="Owners' share" value={money(t.ownerShare, t.currency)} />
            <Figure label="My share" value={money(t.managerShare, t.currency)} tone="var(--success)" />
          </div>
          <div className="px-5 pb-4 grid grid-cols-3 gap-2">
            <Figure label="Tax still to pay" value={money(t.taxDue, t.currency)} tone={t.taxDue > 0 ? "var(--warning)" : undefined} />
            <Figure label="Owed to owners" value={money(t.ownerDue, t.currency)} tone={t.ownerDue > 0 ? "var(--warning)" : undefined} />
            <Figure label="Owed to taskers" value={money(t.taskerDue, t.currency)} tone={t.taskerDue > 0 ? "var(--warning)" : undefined} />
          </div>
        </Card>
      ))}

      <Card>
        <CardHeader title="By account" icon={<Building2 size={16} />} />
        <Table head={["Account", "Owner", "Split / tax", "Revenue", "Tax", "Taskers pay", "Profit", "Owner share", "My share", "Owner due"]} className="px-2 pb-3">
          {books.accounts.map((a, i) => {
            const s = summaries[i];
            return (
              <tr key={a.id} className={cx(!a.active && "opacity-50")}>
                <td className={td}><span className="font-medium">{a.name}</span>{s.jobs.awaitingApproval > 0 && <span className="ml-2"><Pill tone="var(--accent-2)">{s.jobs.awaitingApproval} to approve</Pill></span>}</td>
                <td className={td}>{name(a.ownerId)}</td>
                <td className={`${td} tabular text-fg-2 whitespace-nowrap`}>{a.ownerSharePct}% / {100 - a.ownerSharePct}% · tax {a.taxPct}%</td>
                <td className={num}>{money(s.revenue, a.currency)}</td>
                <td className={num}>{money(s.tax, a.currency)}</td>
                <td className={num}>{money(s.taskerCost, a.currency)}</td>
                <td className={num} style={s.profit < 0 ? { color: "var(--danger)" } : undefined}>{money(s.profit, a.currency)}</td>
                <td className={num}>{money(s.ownerShare, a.currency)}</td>
                <td className={num} style={{ color: "var(--success)" }}>{money(s.managerShare, a.currency)}</td>
                <td className={num}>{money(s.ownerDue, a.currency)}</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Taskers" icon={<Users size={16} />} subtitle="Earned on approved tasks, paid, and still owed" />
          {balances.length === 0 ? <p className="px-5 pb-4 text-sm text-muted">No tasks assigned yet.</p> : (
            <Table head={["Tasker", "Earned", "Paid", "Due", "In hand"]} className="px-2 pb-3">
              {balances.map((b) => (
                <tr key={b.personId + b.currency}>
                  <td className={td}>{name(b.personId)}</td>
                  <td className={num}>{money(b.earned, b.currency)}</td>
                  <td className={num}>{money(b.paid, b.currency)}</td>
                  <td className={num} style={b.due > 0 ? { color: "var(--warning)" } : undefined}>{money(b.due, b.currency)}</td>
                  <td className={num}>{money(b.pending, b.currency)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Last six months"
            icon={<LineChart size={16} />}
            subtitle={`Revenue per month · ${cur}`}
            right={all.length > 1 ? <Segmented size="sm" value={cur} onChange={setCurrency} options={all.map((t) => ({ value: t.currency, label: t.currency }))} /> : undefined}
          />
          <div className="px-5 pb-4">
            <BarChart caption={`Revenue per month in ${cur}`} unit={cur} height={130} data={trend.map((m) => ({ label: m.label, value: Math.round(m.revenue / 100), sub: `My share ${money(m.managerShare, cur)}` }))} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ people

function People() {
  const people = useAccounts((s) => s.books.people);
  const [edit, setEdit] = useState<Partial<Person> | null>(null);
  const [pin, setPin] = useState("");
  const open = (p: Partial<Person> | null) => {
    setPin("");
    setEdit(p);
  };
  return (
    <Card>
      <CardHeader title="People" icon={<Users size={16} />} subtitle="Account owners and taskers" right={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => open({ name: "", owner: false, tasker: true, contact: "", active: true })}>Add person</Button>} />
      {people.length === 0 ? <EmptyState icon={<Users size={22} />} title="Nobody yet" body="Add the owners of the accounts you manage, and the taskers who work on them." /> : (
        <Table head={["Name", "Role", "Contact", "Sign-in", ""]} className="px-2 pb-3">
          {people.map((p) => (
            <tr key={p.id} className={cx(!p.active && "opacity-50")}>
              <td className={`${td} font-medium`}>{p.name}</td>
              <td className={td}><span className="flex gap-1">{p.owner && <Pill tone="var(--accent-2)">Owner</Pill>}{p.tasker && <Pill tone="var(--accent)">Tasker</Pill>}{!p.active && <Pill>Inactive</Pill>}</span></td>
              <td className={`${td} text-fg-2`}>{p.contact || "—"}</td>
              <td className={td}>{p.tasker ? (p.pin ? <Pill tone="var(--success)">PIN set</Pill> : <Pill tone="var(--warning)">No PIN</Pill>) : <span className="text-muted">—</span>}</td>
              <td className={`${td} text-right`}><Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => open(p)}>Edit</Button></td>
            </tr>
          ))}
        </Table>
      )}
      <FormDialog
        open={!!edit}
        title={edit?.id ? "Edit person" : "Add person"}
        onClose={() => setEdit(null)}
        onSave={() => accounts().savePerson({ ...(edit as Person), name: edit?.name ?? "" }, pin || undefined)}
        onRemove={edit?.id ? () => accounts().remove("person", edit.id!) : undefined}
      >
        <Field label="Name"><Input autoFocus value={edit?.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Contact (phone or email)"><Input value={edit?.contact ?? ""} onChange={(e) => setEdit({ ...edit, contact: e.target.value })} /></Field>
        <Toggle checked={!!edit?.owner} onChange={(v) => setEdit({ ...edit, owner: v })} label="Owns accounts" description="Can be chosen as the owner of a managed account and receives the owner's share." />
        <Toggle checked={!!edit?.tasker} onChange={(v) => setEdit({ ...edit, tasker: v })} label="Tasker" description="Can be assigned to accounts and given tasks at a rate." />
        {edit?.tasker && <Field label={edit?.pin ? "New PIN (leave empty to keep the current one)" : "PIN for signing in to the taskers' side"} hint="At least 4 characters. Only a scrambled form is stored."><Input type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="new-password" /></Field>}
        <Toggle checked={edit?.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} label="Active" description="Inactive people keep their history but cannot sign in or be given new tasks." />
      </FormDialog>
    </Card>
  );
}

// ------------------------------------------------------------------ accounts

function AccountsTab() {
  const { list, people } = useAccounts((s) => ({ list: s.books.accounts, people: s.books.people }));
  const [edit, setEdit] = useState<Partial<Account> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owners = people.filter((p) => p.owner && p.active);
  const taskers = people.filter((p) => p.tasker && p.active);
  const toggle = async (a: Account, personId: string) => setError(await accounts().setMember(a.id, personId, !a.memberIds.includes(personId)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Each account has its own owner, profit split and tax rate. One person can own several accounts.</p>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ name: "", ownerId: owners[0]?.id ?? null, ownerSharePct: 50, taxPct: 0, currency: "USD", active: true, notes: "" })}>Add account</Button>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {list.length === 0 && <Card><EmptyState icon={<Building2 size={22} />} title="No accounts yet" body="Add an account, choose its owner, and set the owner's share of the profit and the tax rate." /></Card>}
      <div className="grid lg:grid-cols-2 gap-3">
        {list.map((a) => (
          <Card key={a.id} className={cx("p-4 flex flex-col gap-3", !a.active && "opacity-60")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{a.name}</div>
                <div className="text-xs text-muted">Owner: {people.find((p) => p.id === a.ownerId)?.name ?? "not set"} · {a.currency}</div>
              </div>
              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEdit(a)}>Edit</Button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Figure label="Owner's share" value={`${a.ownerSharePct}%`} />
              <Figure label="My share" value={`${100 - a.ownerSharePct}%`} tone="var(--success)" />
              <Figure label="Tax" value={`${a.taxPct}%`} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-muted mb-1.5">Taskers on this account</div>
              <div className="flex flex-wrap gap-1.5">
                {taskers.length === 0 && <span className="text-xs text-muted">Add taskers under People first.</span>}
                {taskers.map((p) => {
                  const on = a.memberIds.includes(p.id);
                  return <button key={p.id} type="button" aria-pressed={on} onClick={() => void toggle(a, p.id)} title={on ? "Click to take off this account" : "Click to assign to this account"} className={cx("h-7 px-2.5 rounded-lg border text-xs font-medium transition", on ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-muted hover:text-fg")}>{p.name}</button>;
                })}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <FormDialog open={!!edit} title={edit?.id ? "Edit account" : "Add account"} onClose={() => setEdit(null)} onSave={() => accounts().saveAccount({ ...(edit as Account), name: edit?.name ?? "" })} onRemove={edit?.id ? () => accounts().remove("account", edit.id!) : undefined}>
        <Field label="Account name" hint="For example “Upwork · Amina”. Each account needs its own name."><Input autoFocus value={edit?.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Owner">
          <Select value={edit?.ownerId ?? ""} onChange={(e) => setEdit({ ...edit, ownerId: e.target.value || null })}>
            <option value="">Not set</option>
            {owners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Owner's share %" hint={`You keep ${100 - (edit?.ownerSharePct ?? 0)}%`}><Input type="number" min={0} max={100} step={0.5} value={edit?.ownerSharePct ?? 0} onChange={(e) => setEdit({ ...edit, ownerSharePct: Number(e.target.value) })} /></Field>
          <Field label="Tax %" hint="Taken off revenue"><Input type="number" min={0} max={100} step={0.5} value={edit?.taxPct ?? 0} onChange={(e) => setEdit({ ...edit, taxPct: Number(e.target.value) })} /></Field>
          <Field label="Currency"><Select value={edit?.currency ?? "USD"} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        </div>
        <Field label="Notes"><Input value={edit?.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
        <Toggle checked={edit?.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} label="Active" />
      </FormDialog>
    </div>
  );
}

// ------------------------------------------------------------------ projects and tasks

function Work() {
  const books = useAccounts((s) => s.books);
  const [accountId, setAccountId] = useState<string>("all");
  const [project, setProject] = useState<Partial<Project> | null>(null);
  const [place, setPlace] = useState<{ project: Project; mode: "move" | "copy"; to: string } | null>(null);
  const [job, setJob] = useState<(Partial<Job> & { rateText?: string; revenueText?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = books.accounts.filter((a) => accountId === "all" || a.id === accountId);
  const act = async (work: Promise<string | null>) => setError(await work);
  const openJob = (j: Partial<Job>) => setJob({ ...j, rateText: j.rate != null ? cents(j.rate) : "", revenueText: j.revenue != null ? cents(j.revenue) : "" });
  const jobAccount = books.accounts.find((a) => a.id === books.projects.find((p) => p.id === job?.projectId)?.accountId);
  const members = books.people.filter((p) => jobAccount?.memberIds.includes(p.id) && p.active);

  if (!books.accounts.length) return <Card><EmptyState icon={<ClipboardList size={22} />} title="Add an account first" body="Projects live inside accounts, and tasks inside projects." /></Card>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="!w-64" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
          <option value="all">All accounts</option>
          {books.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <span className="text-xs text-muted">A project is in one account at a time. Use Copy to give another account the same project.</span>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {shown.map((a) => {
        const projects = books.projects.filter((p) => p.accountId === a.id);
        return (
          <Card key={a.id}>
            <CardHeader title={a.name} icon={<Building2 size={16} />} subtitle={`${projects.length} project${projects.length === 1 ? "" : "s"}`} right={<Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => setProject({ name: "", accountId: a.id, status: "active", notes: "" })}>Project</Button>} />
            <div className="px-4 pb-4 flex flex-col gap-3">
              {projects.length === 0 && <p className="text-sm text-muted px-1">No projects in this account yet.</p>}
              {projects.map((p) => {
                const jobs = books.jobs.filter((j) => j.projectId === p.id);
                return (
                  <div key={p.id} className="rounded-xl border border-line">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="font-medium text-sm">{p.name}</span>
                      {p.status !== "active" && <Pill>{p.status}</Pill>}
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => openJob({ title: "", projectId: p.id, assigneeId: null, rateType: "fixed", rate: 0, hours: 0, revenue: 0, notes: "" })}>Task</Button>
                        <Button size="sm" variant="ghost" icon={<ArrowRightLeft size={13} />} disabled={books.accounts.length < 2} onClick={() => setPlace({ project: p, mode: "move", to: books.accounts.find((x) => x.id !== a.id)?.id ?? "" })} title="Move this project to another account">Move</Button>
                        <Button size="sm" variant="ghost" icon={<Copy size={13} />} disabled={books.accounts.length < 2} onClick={() => setPlace({ project: p, mode: "copy", to: books.accounts.find((x) => x.id !== a.id)?.id ?? "" })} title="Give another account the same project">Copy</Button>
                        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setProject(p)} aria-label={`Edit ${p.name}`} />
                      </span>
                    </div>
                    {jobs.length > 0 && (
                      <Table head={["Task", "Tasker", "Pay", "Revenue", "Status", ""]} className="border-t border-line">
                        {jobs.map((j) => (
                          <tr key={j.id}>
                            <td className={td}><button type="button" className="text-left hover:text-accent font-medium" onClick={() => openJob(j)}>{j.title}</button></td>
                            <td className={td}>{books.people.find((x) => x.id === j.assigneeId)?.name ?? <span className="text-warning">Unassigned</span>}</td>
                            <td className={num}>{money(jobPay(j), a.currency)}{j.rateType === "hourly" && <span className="text-[10px] text-muted font-sans"> · {j.hours} h</span>}</td>
                            <td className={num}>{money(j.revenue, a.currency)}</td>
                            <td className={td}><Pill tone={JOB_STATUS[j.status].tone}>{JOB_STATUS[j.status].label}</Pill></td>
                            <td className={`${td} text-right whitespace-nowrap`}>
                              {nextStatuses(j, { role: "admin" }).map((n, i) => (
                                <Button key={n} size="sm" variant={i === 0 ? "soft" : "ghost"} onClick={() => void act(accounts().setJobStatus(j.id, n))}>
                                  {i === 0 ? (n === "in_progress" ? "Start" : n === "submitted" ? "Submit" : NEXT_LABEL[n]) : n === "in_progress" ? "Send back" : "Unapprove"}
                                </Button>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </Table>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <FormDialog open={!!project} title={project?.id ? "Edit project" : "Add project"} onClose={() => setProject(null)} onSave={() => accounts().saveProject({ ...(project as Project), name: project?.name ?? "", accountId: project?.accountId ?? "" })} onRemove={project?.id ? () => accounts().remove("project", project.id!) : undefined}>
        <Field label="Project name"><Input autoFocus value={project?.name ?? ""} onChange={(e) => setProject({ ...project, name: e.target.value })} /></Field>
        <Field label="Status"><Select value={project?.status ?? "active"} onChange={(e) => setProject({ ...project, status: e.target.value as Project["status"] })}><option value="active">Active</option><option value="paused">Paused</option><option value="done">Done</option></Select></Field>
        <Field label="Notes"><Input value={project?.notes ?? ""} onChange={(e) => setProject({ ...project, notes: e.target.value })} /></Field>
      </FormDialog>

      <FormDialog open={!!place} title={place?.mode === "move" ? `Move “${place.project.name}” to another account` : `Give another account “${place?.project.name ?? ""}”`} saveLabel={place?.mode === "move" ? "Move" : "Copy"} onClose={() => setPlace(null)} onSave={() => (place!.mode === "move" ? accounts().moveProject(place!.project.id, place!.to) : accounts().copyProject(place!.project.id, place!.to))}>
        <p className="text-sm text-fg-2">{place?.mode === "move" ? "The project and its tasks leave their current account and belong to the one you choose. Their taskers must be assigned to that account." : "The other account gets its own project with the same name. Tasks are not copied; each account keeps its own."}</p>
        <Field label="Account"><Select value={place?.to ?? ""} onChange={(e) => place && setPlace({ ...place, to: e.target.value })}>{books.accounts.filter((x) => x.id !== place?.project.accountId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      </FormDialog>

      <FormDialog
        open={!!job}
        title={job?.id ? "Edit task" : "Assign a task"}
        onClose={() => setJob(null)}
        onSave={async () => {
          const rate = parseMoney(job?.rateText ?? "0");
          const revenue = parseMoney(job?.revenueText ?? "0");
          if (rate == null || revenue == null) return "Enter the amounts as numbers.";
          const { rateText: _r, revenueText: _v, ...rest } = job!;
          void _r; void _v;
          return accounts().saveJob({ ...(rest as Job), title: job?.title ?? "", projectId: job?.projectId ?? "", rate, revenue });
        }}
        onRemove={job?.id ? () => accounts().remove("job", job.id!) : undefined}
      >
        <Field label="Task"><Input autoFocus value={job?.title ?? ""} onChange={(e) => setJob({ ...job, title: e.target.value })} /></Field>
        <Field label="Assign to" hint={jobAccount ? `Taskers on “${jobAccount.name}”` : undefined}>
          <Select value={job?.assigneeId ?? ""} onChange={(e) => setJob({ ...job, assigneeId: e.target.value || null })}>
            <option value="">Nobody yet</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Paid"><Select value={job?.rateType ?? "fixed"} onChange={(e) => setJob({ ...job, rateType: e.target.value as Job["rateType"] })}><option value="fixed">A fixed amount</option><option value="hourly">Per hour</option></Select></Field>
          <Field label={job?.rateType === "hourly" ? `Rate per hour (${jobAccount?.currency ?? ""})` : `Amount (${jobAccount?.currency ?? ""})`}><Input inputMode="decimal" value={job?.rateText ?? ""} onChange={(e) => setJob({ ...job, rateText: e.target.value })} /></Field>
          {job?.rateType === "hourly" ? <Field label="Hours"><Input type="number" min={0} step={0.25} value={job?.hours ?? 0} onChange={(e) => setJob({ ...job, hours: Number(e.target.value) })} /></Field> : <span />}
        </div>
        <Field label={`What the account earns for it (${jobAccount?.currency ?? ""})`} hint="Counts as revenue once the task is approved. The tasker does not see this."><Input inputMode="decimal" value={job?.revenueText ?? ""} onChange={(e) => setJob({ ...job, revenueText: e.target.value })} /></Field>
        <Field label="Instructions"><Input value={job?.notes ?? ""} onChange={(e) => setJob({ ...job, notes: e.target.value })} /></Field>
      </FormDialog>
    </div>
  );
}

// ------------------------------------------------------------------ ledger

const KIND: Record<EntryKind, { label: string; tone: string; who?: "tasker" | "owner" }> = {
  tasker_pay: { label: "Paid a tasker", tone: "var(--accent)", who: "tasker" },
  owner_payout: { label: "Paid out to the owner", tone: "var(--accent-2)", who: "owner" },
  tax: { label: "Tax paid", tone: "var(--warning)" },
  income: { label: "Other income", tone: "var(--success)" },
  expense: { label: "Expense", tone: "var(--danger)" },
};

function Ledger() {
  const books = useAccounts((s) => s.books);
  const [accountId, setAccountId] = useState(books.accounts[0]?.id ?? "");
  const [kind, setKind] = useState<EntryKind>("tasker_pay");
  const [personId, setPersonId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const account = books.accounts.find((a) => a.id === accountId);
  const who = KIND[kind].who;
  const choices = who === "tasker" ? books.people.filter((p) => account?.memberIds.includes(p.id)) : who === "owner" ? books.people.filter((p) => p.id === account?.ownerId) : [];
  const add = async () => {
    const value = parseMoney(amount);
    if (value == null) return setError("Enter the amount as a number.");
    const why = await accounts().addEntry({ accountId, kind, amount: value, personId: who ? personId || choices[0]?.id || null : null, jobId: null, note: note.trim() });
    setError(why);
    if (!why) {
      setAmount("");
      setNote("");
    }
  };
  if (!books.accounts.length) return <Card><EmptyState icon={<Banknote size={22} />} title="Add an account first" body="The ledger records money that actually moved: payments to taskers, payouts to owners, tax paid." /></Card>;
  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4 flex flex-col gap-3">
        <div className="text-sm font-medium">Record a payment</div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Field label="Account"><Select className="!w-52" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPersonId(""); }}>{books.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="What"><Select className="!w-52" value={kind} onChange={(e) => { setKind(e.target.value as EntryKind); setPersonId(""); }}>{(Object.keys(KIND) as EntryKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}</Select></Field>
          {who && <Field label={who === "tasker" ? "Tasker" : "Owner"}><Select className="!w-44" value={personId || choices[0]?.id || ""} onChange={(e) => setPersonId(e.target.value)}>{choices.length === 0 && <option value="">Nobody to choose</option>}{choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
          <Field label={`Amount (${account?.currency ?? ""})`}><Input className="!w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Note" className="flex-1 min-w-[140px]"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button type="submit" variant="primary" icon={<Plus size={14} />}>Record</Button>
        </form>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </Card>
      <Card>
        <CardHeader title="Ledger" icon={<Banknote size={16} />} subtitle="Newest first" />
        {books.entries.length === 0 ? <p className="px-5 pb-4 text-sm text-muted">Nothing recorded yet.</p> : (
          <Table head={["Date", "Account", "What", "Who", "Note", "Amount", ""]} className="px-2 pb-3">
            {[...books.entries].sort((a, b) => b.at - a.at).map((e) => {
              const a = books.accounts.find((x) => x.id === e.accountId);
              return (
                <tr key={e.id}>
                  <td className={`${td} tabular text-fg-2 whitespace-nowrap`}>{new Date(e.at).toLocaleDateString()}</td>
                  <td className={td}>{a?.name}</td>
                  <td className={td}><Pill tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Pill></td>
                  <td className={td}>{books.people.find((p) => p.id === e.personId)?.name ?? "—"}</td>
                  <td className={`${td} text-fg-2`}>{e.note || "—"}</td>
                  <td className={num}>{money(e.amount, a?.currency ?? "USD")}</td>
                  <td className={`${td} text-right`}><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label="Remove this entry" onClick={() => void accounts().remove("entry", e.id).then(setError)} /></td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

/** The manager's side: everything, in five tabs. */
export function AdminHome() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: "Overview", title: "Balances and analysis" },
          { value: "accounts", label: "Accounts", title: "Accounts, their owners, split, tax and taskers" },
          { value: "people", label: "People", title: "Owners and taskers" },
          { value: "work", label: "Projects & tasks", title: "Projects per account and the tasks given out" },
          { value: "ledger", label: "Ledger", title: "Payments made" },
        ]}
      />
      {tab === "overview" ? <Overview /> : tab === "accounts" ? <AccountsTab /> : tab === "people" ? <People /> : tab === "work" ? <Work /> : <Ledger />}
    </div>
  );
}
