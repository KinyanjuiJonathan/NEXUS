import { useMemo, useState } from "react";
import { CheckCircle2, Play, Send } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, Input } from "@/components/ui";
import { jobPay, money, taskerBalances } from "../finance";
import { nextStatuses, visibleTo } from "../rules";
import type { Job, JobStatus } from "../types";
import { accounts, useAccounts } from "../useAccounts";
import { Figure, Pill, Table, num, td } from "./parts";

const STATUS: Record<JobStatus, { label: string; tone: string }> = {
  assigned: { label: "To do", tone: "var(--accent)" },
  in_progress: { label: "In progress", tone: "var(--warning)" },
  submitted: { label: "Waiting for approval", tone: "var(--accent-2)" },
  approved: { label: "Approved", tone: "var(--success)" },
  paid: { label: "Paid", tone: "var(--success)" },
};
export const JOB_STATUS = STATUS;

/**
 * The taskers' side: the accounts and projects a tasker is on, their own
 * tasks (start, log hours, submit) and what they have earned and been paid.
 * It is given only what `visibleTo` lets a tasker see.
 */
export function TaskerHome({ personId }: { personId: string }) {
  const all = useAccounts((s) => s.books);
  const books = useMemo(() => visibleTo(all, { role: "tasker", personId }), [all, personId]);
  const me = books.people[0];
  const balances = useMemo(() => taskerBalances(books), [books]);
  const [error, setError] = useState<string | null>(null);
  const projectName = (id: string) => books.projects.find((p) => p.id === id)?.name ?? "";
  const accountOf = (j: Job) => books.accounts.find((a) => a.id === books.projects.find((p) => p.id === j.projectId)?.accountId);
  const act = async (work: Promise<string | null>) => setError(await work);
  const open = books.jobs.filter((j) => j.status !== "paid").sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const done = books.jobs.filter((j) => j.status === "paid");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold">Hello, {me?.name ?? "there"}</h2>
        <p className="text-sm text-muted">Your accounts, your tasks and what you have earned.</p>
      </div>

      {balances.length > 0 && (
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {balances.flatMap((b) => [
            <Figure key={`e${b.currency}`} label="Earned" value={money(b.earned, b.currency)} hint="On approved tasks" />,
            <Figure key={`p${b.currency}`} label="Paid to you" value={money(b.paid, b.currency)} />,
            <Figure key={`d${b.currency}`} label="Still owed to you" value={money(b.due, b.currency)} tone={b.due > 0 ? "var(--success)" : undefined} />,
            <Figure key={`w${b.currency}`} label="In hand" value={money(b.pending, b.currency)} hint="Tasks not approved yet, at their agreed pay" />,
          ])}
        </div>
      )}

      <Card>
        <CardHeader title="My tasks" icon={<CheckCircle2 size={16} />} subtitle={`${open.length} open`} />
        {error && <p role="alert" className="px-5 pb-2 text-xs text-danger">{error}</p>}
        {open.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing waiting for you" body="New tasks appear here when the manager assigns them." />
        ) : (
          <Table head={["Task", "Account · project", "Pay", "Status", ""]} className="px-2 pb-3">
            {open.map((j) => {
              const next = nextStatuses(j, { role: "tasker", personId });
              const currency = accountOf(j)?.currency ?? "USD";
              return (
                <tr key={j.id}>
                  <td className={td}>
                    <div className="font-medium">{j.title}</div>
                    {j.notes && <div className="text-[11px] text-muted line-clamp-2">{j.notes}</div>}
                    {j.dueAt && <div className="text-[11px] text-muted">Due {new Date(j.dueAt).toLocaleDateString()}</div>}
                  </td>
                  <td className={td}><span className="text-fg-2">{accountOf(j)?.name}</span> · {projectName(j.projectId)}</td>
                  <td className={num}>
                    {money(jobPay(j), currency)}
                    {j.rateType === "hourly" && (
                      <div className="flex items-center justify-end gap-1 mt-1 text-[11px] text-muted font-sans">
                        <Input type="number" min={0} step={0.25} defaultValue={j.hours} disabled={j.status === "approved"} onBlur={(e) => Number(e.target.value) !== j.hours && void act(accounts().logHours(j.id, Number(e.target.value)))} className="!h-7 !w-16 text-xs" aria-label={`Hours worked on ${j.title}`} />
                        h × {money(j.rate, currency)}
                      </div>
                    )}
                  </td>
                  <td className={td}><Pill tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Pill></td>
                  <td className={`${td} text-right`}>
                    {next.includes("in_progress") && <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => void act(accounts().setJobStatus(j.id, "in_progress"))}>Start</Button>}
                    {next.includes("submitted") && <Button size="sm" variant="primary" icon={<Send size={13} />} onClick={() => void act(accounts().setJobStatus(j.id, "submitted"))}>Submit</Button>}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="My accounts and projects" />
          <div className="px-5 pb-4 flex flex-col gap-2">
            {books.accounts.length === 0 && <p className="text-sm text-muted">You are not assigned to an account yet.</p>}
            {books.accounts.map((a) => (
              <div key={a.id} className="rounded-xl border border-line px-3 py-2">
                <div className="text-sm font-medium">{a.name}</div>
                <div className="text-[11px] text-muted">{books.projects.filter((p) => p.accountId === a.id).map((p) => p.name).join(" · ") || "No projects yet"}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Payments received" subtitle={`${done.length} task${done.length === 1 ? "" : "s"} paid`} />
          <div className="px-5 pb-4 flex flex-col gap-1.5">
            {books.entries.length === 0 && <p className="text-sm text-muted">No payments recorded yet.</p>}
            {[...books.entries].sort((a, b) => b.at - a.at).map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-fg-2 truncate">{new Date(e.at).toLocaleDateString()} · {books.accounts.find((a) => a.id === e.accountId)?.name}{e.note ? ` · ${e.note}` : ""}</span>
                <span className="font-mono tabular text-success">{money(e.amount, books.accounts.find((a) => a.id === e.accountId)?.currency ?? "USD")}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
