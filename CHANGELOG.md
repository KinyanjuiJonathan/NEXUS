# NEXUS update history

NEXUS stays on version 1: every release is a 1.x.y number, raised by one step each time. Installing any release over an older one keeps your tasks, schedule, history and settings (they live in `%APPDATA%\com.nexus.productivity`, which the installer never touches, and the database is backed up before any change to its format).

## v1.1.1 (23 November 2026)

**A schedule that adapts to you**
- Flexible routine (on by default): the times in *Daily routine* are a starting point, not a timetable.
- While you are still working, sleep that is due moves later and keeps its full length; the next day shifts with it.
- After four hours with no activity NEXUS asks whether that was your sleep, or your sleep and breakfast. A yes makes it so: the day starts when you are back.
- After sleep, admin and planning tasks go to the front of the queue, and the rest of the day is refitted into the time you have.
- The whole waking day after the morning routine is open for work (12 hours at most). Only the gym keeps its fixed time and is never rescheduled.

**Calendar**
- *Fit day*: the hours size themselves so the whole waking day is visible without scrolling.
- Slide the days sideways one at a time (trackpad, Shift + wheel, or the small arrows).
- Task blocks take their category's colour, with a flag for high priority; short blocks show their time beside the title.
- Smoother switching between Day, Week, Month and Agenda.

**Releases**
- Builds can be published as a release from the build workflow after all tests pass.

## v1.1.0 (22 November 2026)

- Start any task now: it begins in the next minute, the work clock counts, and tasks in the way follow in order.
- "now" and "in a minute" in AI Schedule mean exactly then.
- Start-up fix: saved data always loads after a Windows restart. Recovery screen, safe opening of the database, and more backups (daily and every three hours).
- Daily routine (sleep, sessions, breaks, lunch, gym) and first-in, first-out scheduling.
- Queue drag-and-drop, exact pushes with Undo, task switching, split-task merging.
- Calendar: Agenda view, search and filters, drag across weeks, snapping, resize from both edges.
- Time zone and working-hours panel.
- Auto Typer: correct punctuation keys, shortest corrections, word-processor editing pad.
- Compact work clock, version and build labels, update check and feedback form.

## v1.0.0

- First version: tasks, calendar, focus timers, world clocks, floating overlay, voice commands and smart scheduling.
