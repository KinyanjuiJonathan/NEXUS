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
    version: "1.1.2",
    date: "2026-11-23",
    title: "Calendar: zoom, depth and motion",
    changes: [
      "Zoom the calendar: slider, Ctrl + wheel around the pointer, or + and − (0 fits the day).",
      "Zoomed in, blocks show their length, checklist progress and notes; half and quarter hours are labelled.",
      "Blocks are raised, lit tiles with coloured shadows; the one you drag lifts off the page.",
      "A hairline follows the pointer and shows the time it points at.",
      "Views tip into place and days slide in from the side you came from.",
    ],
  },
  {
    version: "1.1.1",
    date: "2026-11-23",
    title: "A schedule that adapts to you, and a calendar you can read at a glance",
    changes: [
      "Flexible routine: sleep moves later while you are still working, with its full length kept.",
      "After four hours away NEXUS asks whether that was your sleep (and breakfast); your day then starts when you are back.",
      "Admin and planning tasks go first after sleep; the rest of the day is refitted around the time you have.",
      "The whole waking day is open for work; only the gym keeps its fixed time.",
      "Calendar: the day fits the window, days slide sideways, blocks are coloured by category with priority flags.",
      "Releases are published from the build workflow; versions stay within 1.x.",
    ],
  },
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

/** NEXUS stays on version 1 until its owner says otherwise. */
export const MAJOR = 1;
