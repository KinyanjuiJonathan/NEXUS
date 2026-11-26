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
    version: "1.1.16",
    date: "2026-11-26",
    title: "Full-screen calendar with a compact toolbar",
    changes: [
      "The Calendar now fills the whole window, edge to edge and down to the bottom, in every view.",
      "Its two rows of controls are one line: date navigation, the view switch, search, and three menus (Filter, View, Plan).",
      "Zone, zoom, working hours, routine, the legend and the tips are under View; Auto-plan, Reschedule all and AI Schedule are under Plan.",
    ],
  },
  {
    version: "1.1.15",
    date: "2026-11-26",
    title: "Wallpaper effect: easy to turn off or re-time",
    changes: [
      "The wallpaper effect (ambient mode) has its own section in Settings, with an on/off switch.",
      "Set exactly when it starts (1 to 240 minutes) and how long it stays on a page (10 seconds to an hour), or pick a quick choice.",
      "The first time it runs in a session, a notice offers Turn off and says where the settings are.",
    ],
  },
  {
    version: "1.1.14",
    date: "2026-11-25",
    title: "New tasks are scheduled automatically",
    changes: [
      "A new task with no start time is put on the calendar at the soonest free time, before its deadline.",
      "A task without an estimate gets one hour. Before, only tasks with an estimate were scheduled.",
      "If working hours have no room before the deadline, the soonest free time at any hour is used.",
    ],
  },
  {
    version: "1.1.13",
    date: "2026-11-25",
    title: "One-click updates; more time for overdue tasks",
    changes: [
      "Install now: when a new version is out, one click downloads it, checks it and updates NEXUS without the installer's pages. NEXUS reopens by itself.",
      "Extend an overdue task: a task that ran out of time can be given 15 minutes to 3 hours more, starting now. It stops being overdue and later tasks move along.",
    ],
  },
  {
    version: "1.1.12",
    date: "2026-11-25",
    title: "Calendar opens at now; continuous system graph",
    changes: [
      "The Calendar opens on today with the current time in view, and the Today button (or T) brings it back there.",
      "The System Monitor graph keeps recording while you are on other pages, so it continues from its history instead of starting empty.",
    ],
  },
  {
    version: "1.1.11",
    date: "2026-11-25",
    title: "Deadline glow removed",
    changes: [
      "Removed the glowing deadline effects and the Deadline radar from the Dashboard, task lists, queue and Calendar.",
      "Overdue tasks are still marked in red as before. Extend, Repeat and ambient mode are unchanged.",
    ],
  },
  {
    version: "1.1.10",
    date: "2026-11-25",
    title: "Extend, repeat, deadline glow and ambient mode",
    changes: [
      "Extend: give a task 15 minutes to 3 hours more; the tasks after it move along in the same order.",
      "Repeat: add one more session of a task, right after it or in the next free time. A finished task is repeated as a new one.",
      "Tasks close to their deadline glow: amber within a day, orange within two hours, red once late, on the lists and on the calendar.",
      "Deadline radar on the Dashboard and Calendar shows what is running out, most urgent first.",
      "Ambient mode: left alone, NEXUS drifts between pages with smooth transitions; any input returns you to where you were.",
    ],
  },
  {
    version: "1.1.9",
    date: "2026-11-24",
    title: "A rescheduled task is no longer overdue",
    changes: [
      "Moving an overdue task to a time that is still ahead updates its due time to match, so it stops showing as overdue everywhere.",
      "This applies to dragging on the calendar, reordering the queue, Start now, the +time buttons and rescheduling all tasks.",
      "A deadline that has not passed yet is never changed by moving the task.",
    ],
  },
  {
    version: "1.1.8",
    date: "2026-11-24",
    title: "Time saved goes to what is next",
    changes: [
      "Marking a task complete early ends its block on the calendar at that moment; the unused time is removed.",
      "The tasks that follow come forward to use the time saved, in the same order, one straight after the other.",
      "A notice shows how much was saved and each task's old and new time, with Undo.",
      "Fixed appointments, personal time and tasks planned for later days are not moved.",
    ],
  },
  {
    version: "1.1.7",
    date: "2026-11-24",
    title: "Accounts: managed accounts, taskers and money",
    changes: [
      "New Accounts area: the accounts you manage for other people, each with its own owner, profit split, tax rate and currency. One person can own several.",
      "Assign taskers to accounts, give them tasks at a fixed or hourly rate, and approve and pay the work.",
      "Balances and analysis: revenue, tax, tasker pay, profit, the owner's share and yours, and what is still owed to whom.",
      "Sign in with Windows Hello (fingerprint, face or PIN) or a manager passcode; taskers sign in with their own PIN and see only their own work and pay.",
      "A project belongs to one account at a time; it can be moved, or copied so another account has the same project.",
    ],
  },
  {
    version: "1.1.6",
    date: "2026-11-24",
    title: "Work clock counts only real work",
    changes: [
      "Fixed: the work clock could show more than 24 hours in a day and keep counting while paused.",
      "Stray work sessions left open in the background are closed automatically, and can no longer be created.",
      "The same minute is never counted twice.",
    ],
  },
  {
    version: "1.1.5",
    date: "2026-11-23",
    title: "Dictation that hears everything",
    changes: [
      "Dictation now listens continuously: one recogniser stays open, so words said between phrases are no longer lost.",
      "The phrase being spoken is shown live before it is typed.",
      "“Keep up with my speech” types quickly and without deliberate typos so nothing queues up.",
      "Uses Windows' dictation model, meant for sentences; phrases Windows is unsure about are marked.",
    ],
  },
  {
    version: "1.1.4",
    date: "2026-11-23",
    title: "Region picker fixes and the microphone in view",
    changes: [
      "Fixed: selecting a screen region no longer closes NEXUS.",
      "The region picker now opens on every monitor, so a region on an extended screen can be selected.",
      "Dictation shows the microphone in use, a live input level, a Test button, the other microphones found and a shortcut to Windows sound settings.",
    ],
  },
  {
    version: "1.1.3",
    date: "2026-11-23",
    title: "Auto Typer: dictate, and mirror text from the screen",
    changes: [
      "Voice: speak and NEXUS types what you say into the text box you click in, with spoken punctuation and “delete that”.",
      "Screen (beta): select part of the screen; text that appears there is read on this PC and typed into another app.",
      "An Input → Output view shows what came in and what was typed.",
    ],
  },
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
