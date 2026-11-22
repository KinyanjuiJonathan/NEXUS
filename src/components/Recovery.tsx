import { useEffect, useState } from "react";
import { DatabaseBackup, FolderOpen, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { DateTime } from "luxon";
import { nexus } from "@/store";
import { native, openDataFolder, startupFresh, startupRestore, startupRetry, startupStatus } from "@/lib/platform";
import { backupKind, bestBackup, plainError, type BackupInfo, type StartupStatus } from "@/lib/startup";
import { Button, cx } from "./ui";
import { confirm } from "./Confirm";

const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (ms: number) => (ms ? DateTime.fromMillis(ms).toFormat("ccc d LLL yyyy, h:mm a") : "unknown date");

const HEADLINE: Record<string, string> = {
  missing: "The database file is not where it should be, but your backups are.",
  unreadable: "The database file is there, but it could not be opened.",
  corrupt: "The database file is damaged.",
  newer: "This data was saved by a newer version of NEXUS.",
};

/**
 * Shown instead of the app when saved data could not be loaded. Nothing is
 * displayed as if the user had no data, and nothing is created or overwritten
 * until they choose what to do. Every option keeps a copy of what is there now.
 */
export function RecoveryScreen({ error }: { error: string }) {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => setStatus(await startupStatus().catch(() => null));
  useEffect(() => {
    void refresh();
  }, [error]);

  const reload = async () => {
    await nexus().init();
    await refresh();
  };
  const run = async (key: string, work: () => Promise<string | null | void>, done: string) => {
    setBusy(key);
    setNote(null);
    try {
      const kept = await work();
      await reload();
      if (!nexus().error) nexus().toast({ kind: "success", title: done, body: kept ? `The previous file was kept as ${kept}.` : undefined, ttl: 0 });
    } catch (e) {
      setNote(plainError(e));
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  const restore = async (b: BackupInfo) => {
    const ok = await confirm({
      title: "Restore this backup?",
      body: (
        <>
          NEXUS will use the copy saved on <b className="text-fg">{when(b.modifiedMs)}</b>
          {b.tasks != null && <> ({b.tasks} tasks, {b.events ?? 0} calendar entries)</>}. The file that is there now is first copied into the backups folder, so nothing is lost.
        </>
      ),
      confirmLabel: "Restore",
    });
    if (ok) await run(b.path, () => startupRestore(b.path), "Your data was restored from the backup");
  };
  const fresh = async () => {
    const ok = await confirm({
      title: "Start with an empty NEXUS?",
      body: "Only choose this if you do not want the saved data back. The file that is there now is copied into the backups folder first, so you can still restore it later from Settings → Data.",
      confirmLabel: "Start empty",
      danger: true,
    });
    if (ok) await run("fresh", startupFresh, "Started with an empty database");
  };

  const best = status ? bestBackup(status.backups) : null;
  const waiting = status?.state === "starting";
  const headline = status?.problem ? HEADLINE[status.problem] : waiting ? "NEXUS is still opening its database." : "Your saved data could not be loaded.";

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto scroll-y flex justify-center px-6 py-10" role="alert">
      <div className="w-full max-w-2xl flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 text-warning bg-[color-mix(in_oklab,var(--warning)_14%,transparent)]"><TriangleAlert size={20} /></span>
          <div>
            <h1 className="font-display text-xl font-semibold">{headline}</h1>
            <p className="text-sm text-fg-2 mt-1">
              <ShieldCheck size={14} className="inline -mt-0.5 mr-1 text-success" />
              Nothing has been deleted or overwritten. NEXUS will not show an empty dashboard in place of your data; choose how to continue below.
            </p>
          </div>
        </div>

        <div className="glass rounded-2xl p-4 flex flex-col gap-2 text-sm">
          <p className="text-fg-2 break-words"><span className="text-muted">What happened: </span>{plainError(status?.message || error)}</p>
          {status?.dbPath && (
            <p className="text-[12px] text-muted break-all">
              Database: <span className="font-mono text-fg-2">{status.dbPath}</span> · {status.dbExists ? `${size(status.dbBytes)} on disk` : "not found"}
            </p>
          )}
          {note && <p className="text-[12px] text-danger break-words">That did not work: {note} Nothing was changed.</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" icon={<RefreshCw size={15} className={cx(busy === "retry" && "animate-spin")} />} disabled={!!busy} onClick={() => void run("retry", native ? startupRetry : async () => undefined, "Your data was loaded")}>Try again</Button>
            {best && <Button variant="soft" icon={<DatabaseBackup size={15} />} disabled={!!busy} onClick={() => void restore(best)}>Restore the latest backup</Button>}
            {native && <Button variant="ghost" icon={<FolderOpen size={15} />} disabled={!!busy} onClick={() => void openDataFolder().catch((e) => setNote(plainError(e)))}>Open the data folder</Button>}
          </div>
          <p className="text-[11px] text-muted">“Try again” only reads the database; it is the right first step, and usually all that is needed after a restart.</p>
        </div>

        {status && status.backups.length > 0 && (
          <div className="glass rounded-2xl p-4 flex flex-col gap-2">
            <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-muted">Backups on this computer · {status.backups.length}</h2>
            <div className="flex flex-col divide-y divide-[var(--border)] max-h-72 overflow-y-auto scroll-y">
              {status.backups.map((b) => (
                <div key={b.path} className="flex items-center gap-3 py-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{when(b.modifiedMs)} <span className="text-muted font-normal">· {backupKind(b.name)}</span></div>
                    <div className="text-[11px] text-muted tabular truncate" title={b.path}>
                      {b.valid ? (b.tasks != null ? `${b.tasks} tasks · ${b.events ?? 0} calendar entries · ` : "") : "could not be read · "}{size(b.bytes)} · {b.name}
                    </div>
                  </div>
                  <Button size="sm" variant={b === best ? "soft" : "ghost"} disabled={!!busy || !b.valid} onClick={() => void restore(b)}>{busy === b.path ? "Restoring…" : "Restore"}</Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-muted">
          <span>Backups are written automatically: one a day (14 kept) and one every few hours while NEXUS runs (8 kept).</span>
          {native && status?.state === "failed" && <button type="button" className="underline hover:text-danger" disabled={!!busy} onClick={() => void fresh()}>Start with an empty NEXUS instead…</button>}
        </div>
      </div>
    </div>
  );
}
