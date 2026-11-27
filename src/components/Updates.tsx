import { useEffect, useState } from "react";
import { Download, MessageSquarePlus, RefreshCw } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { installUpdate, latestRelease, native, openExternal, type ReleaseInfo } from "@/lib/platform";
import { CHANGELOG, versionLabel } from "@/lib/changelog";
import { REPO_URL, feedbackBody, feedbackTitle, feedbackUrl, isNewer, type FeedbackKind } from "@/lib/updates";
import { Button, Select, Toggle, cx } from "./ui";

const AREAS = ["", "Dashboard", "Tasks & queue", "Calendar", "Scheduling", "Work clock", "Auto Typer", "Overlay", "Settings", "Installer / update"];

/** Look for a newer release. Returns it when there is one. Quiet unless asked to report. */
export async function checkForUpdate(report: boolean): Promise<ReleaseInfo | null> {
  const s = nexus();
  try {
    const rel = await latestRelease();
    if (rel && isNewer(rel.version, __APP_VERSION__)) {
      const page = () => void openExternal(rel.url || `${REPO_URL}/releases/latest`).catch(() => {});
      const name = `NEXUS ${rel.version.replace(/^v/i, "")}`;
      // One click when the release carries a verifiable installer; otherwise the download page.
      const direct = !!rel.installerUrl && rel.installerSha256.length === 64;
      const install = async () => {
        const wait = s.toast({ kind: "info", title: `Downloading ${name}…`, body: "NEXUS will close, update and open again by itself. There is nothing to click.", ttl: 0 });
        try {
          await installUpdate(rel);
        } catch (e) {
          s.dismissToast(wait);
          s.toast({ kind: "warning", title: "The update could not be installed automatically", body: `${e instanceof Error ? e.message : String(e)} You can still install it from the download page.`, action: { label: "Open download page", run: page }, ttl: 0 });
        }
      };
      s.toast({
        kind: "info",
        title: `${name} is available`,
        body: `You have ${__APP_VERSION__}. ${direct ? "Install now downloads it, checks it and updates NEXUS without the installer's questions." : "Installing the new version over this one keeps your data."} Your tasks, history and settings are kept.`,
        action: direct ? { label: "Install now", run: () => void install() } : { label: "Open download page", run: page },
        ttl: 0,
      });
      return rel;
    }
    if (report) s.toast({ kind: "success", title: rel ? "NEXUS is up to date" : "No newer version has been published", body: `You have ${__APP_VERSION__}.`, ttl: 5000 });
  } catch (e) {
    if (report) s.toast({ kind: "warning", title: "Could not check for updates", body: e instanceof Error ? e.message : String(e), ttl: 7000 });
  }
  return null;
}

/** Once at start-up and then daily: notice that the app was updated, and look for a newer version. */
export function useUpdates() {
  const ready = useNexus((s) => s.ready);
  useEffect(() => {
    if (!ready) return;
    const s = nexus();
    const last = s.settings.lastVersion;
    if (last !== __APP_VERSION__) {
      void (async () => {
        if (last) {
          await s.setSetting("previousVersion", last);
          s.toast({ kind: "success", title: `Updated to NEXUS ${__APP_VERSION__}`, body: `Everything carried on from where it was: your work clock, the task under way and your timers. Your data from ${last} was kept.`, ttl: 12_000 });
        }
        await s.setSetting("lastVersion", __APP_VERSION__);
      })();
    }
    if (!native) return;
    const run = () => {
      if (nexus().settings.updateAuto) void checkForUpdate(false);
    };
    const first = setTimeout(run, 20_000);
    const daily = setInterval(run, 24 * 3600_000);
    return () => {
      clearTimeout(first);
      clearInterval(daily);
    };
  }, [ready]);
}

/** Settings → About: version, update check and the feedback form. */
export function UpdatesAndFeedback() {
  const { auto, previous } = useNexus((s) => ({ auto: s.settings.updateAuto, previous: s.settings.previousVersion }));
  const [checking, setChecking] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("problem");
  const [area, setArea] = useState("");
  const [text, setText] = useState("");
  const s = nexus();
  const input = { kind, area, text, version: __APP_VERSION__, previousVersion: previous, platform: typeof navigator !== "undefined" ? navigator.userAgent.replace(/\s+/g, " ").slice(0, 120) : "" };

  const send = async () => {
    try {
      await openExternal(feedbackUrl(input));
      s.toast({ kind: "success", title: "Feedback opened in your browser", body: "Review it and press Submit there. Nothing was sent by NEXUS itself.", ttl: 7000 });
      setText("");
    } catch (e) {
      s.toast({ kind: "warning", title: "Could not open the browser", body: `${e instanceof Error ? e.message : String(e)} Use Copy instead and paste it wherever you send feedback.`, ttl: 8000 });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${feedbackTitle(input)}\n\n${feedbackBody(input)}`);
      s.toast({ kind: "success", title: "Feedback copied", ttl: 3000 });
    } catch {
      s.toast({ kind: "warning", title: "Could not copy", ttl: 4000 });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">Version <b className="font-mono">{versionLabel(__APP_VERSION__, __APP_BUILD__, __APP_BUILT_ON__)}</b>{previous && previous !== __APP_VERSION__ ? <span className="text-muted"> · updated from v{previous}</span> : null}</span>
        <Button size="sm" variant="outline" icon={<RefreshCw size={14} className={cx(checking && "animate-spin")} />} disabled={checking || !native} onClick={async () => { setChecking(true); await checkForUpdate(true); setChecking(false); }}>Check for updates</Button>
        <Button size="sm" variant="ghost" icon={<Download size={14} />} onClick={() => void openExternal(`${REPO_URL}/releases`).catch(() => {})}>All versions</Button>
      </div>
      <Toggle checked={auto} onChange={(v) => void s.setSetting("updateAuto", v)} label="Check for updates automatically" description="Once a day NEXUS asks whether a newer version has been published and tells you when there is one. “Install now” then updates NEXUS in one click, without the installer’s pages; your tasks, history and settings are kept." />
      <div className="rounded-xl border border-line p-3 flex flex-col gap-3">
        <div className="text-sm font-medium">What changed in each version</div>
        {CHANGELOG.map((r) => (
          <div key={r.version}>
            <div className="flex items-baseline gap-2 text-sm">
              <b className={cx("font-mono", r.version === __APP_VERSION__ ? "text-accent" : "text-fg-2")}>v{r.version}</b>
              <span className="text-fg-2">{r.title}</span>
              {r.version === __APP_VERSION__ && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-success bg-[color-mix(in_oklab,var(--success)_14%,transparent)]">installed</span>}
              <span className="ml-auto text-[11px] text-muted tabular">{r.date}</span>
            </div>
            <ul className="mt-1 text-[12px] text-muted list-disc pl-5 space-y-0.5">
              {r.changes.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line p-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm font-medium"><MessageSquarePlus size={15} className="text-accent" /> Send feedback</div>
        <div className="flex flex-wrap gap-2">
          <Select className="!w-44" value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind)} aria-label="Kind of feedback">
            <option value="problem">Something is wrong</option>
            <option value="idea">An idea</option>
            <option value="praise">Something works well</option>
          </Select>
          <Select className="!w-48" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Part of NEXUS">
            {AREAS.map((a) => <option key={a} value={a}>{a || "Any part of NEXUS"}</option>)}
          </Select>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={previous && previous !== __APP_VERSION__ ? `What changed for you since ${previous}? What should be different?` : "What happened, and what did you expect?"} aria-label="Your feedback" className="rounded-xl bg-hover border border-line px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:border-accent resize-y" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void send()}>Open as a report</Button>
          <Button size="sm" variant="ghost" disabled={!text.trim()} onClick={() => void copy()}>Copy</Button>
          <span className="text-[11px] text-muted">Your version{previous && previous !== __APP_VERSION__ ? ` and the one before (${previous})` : ""} are added. It opens in your browser for you to review and submit.</span>
        </div>
      </div>
    </div>
  );
}
