/**
 * What each version brought, newest first. Shown in Settings → About, so an
 * update can be recognised by its number and by what changed.
 */
export interface Release {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: "1.1.0",
    date: "2026-11-22",
    title: "Start now, safer start-up, daily routine",
    changes: [
      "Start any task now: it begins in the next minute, the work clock counts, and tasks in the way follow in order.",
      "“now” and “in a minute” in AI Schedule mean exactly then.",
      "Start-up fix: saved data always loads after a Windows restart; recovery screen and more backups.",
      "Daily routine (sleep, sessions, breaks, lunch, gym) and first-in, first-out scheduling.",
      "Queue drag-and-drop, exact pushes with Undo, calendar redesign, time zone and working hours panel.",
      "Auto Typer: correct punctuation keys, shortest corrections, word-processor editing pad.",
      "Compact work clock, version and build labels, update check and feedback.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-10-01",
    title: "First release",
    changes: ["Tasks, calendar, focus timers, world clocks, overlay, voice commands and smart scheduling."],
  },
];

/** "v1.1.0 · build 845442c · 22 Nov 2026" */
export function versionLabel(version: string, build: string, builtOn: string): string {
  const d = new Date(`${builtOn}T00:00:00Z`);
  const date = Number.isNaN(d.getTime()) ? builtOn : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `v${version} · build ${build} · ${date}`;
}
