# NEXUS update history

NEXUS stays on version 1: every release is a 1.x.y number, raised by one step each time. Installing any release over an older one keeps your tasks, schedule, history and settings (they live in `%APPDATA%\com.nexus.productivity`, which the installer never touches, and the database is backed up before any change to its format).

## v1.1.5 (23 November 2026)

**Dictation that hears everything**
- **Fixed: words went missing while dictating.** Dictation listened to one phrase at a time and restarted the recogniser in between; whatever was said during a restart was never heard. It now keeps one recogniser open for the whole session (Windows' continuous dictation), so every phrase is handed over as it finishes. Windows ending a session after a long silence is handled by starting it again.
- It uses Windows' dictation model, which is meant for sentences rather than short commands.
- The phrase being spoken appears live in the input box before it is finished and typed; a phrase Windows was not confident about is marked “(unsure)”.
- **Keep up with my speech** (on by default): live text is typed quickly and without deliberate typos, so nothing queues up while you talk.

## v1.1.4 (23 November 2026)

- **Fixed: selecting a screen region closed NEXUS.** Closing the selection window was treated as closing the last window of the app. Helper windows can no longer quit NEXUS.
- **Extended screens.** The region picker opens on every monitor (one sheet per screen, so different display scaling is handled correctly); drag on whichever screen holds the text. A region on a second monitor is read like any other.
- **Microphone.** Dictation shows the microphone in use (the Windows default input), a live input level with a peak marker, a *Test* button, the other microphones Windows knows about, and *Change*, which opens Windows sound settings to pick another one.

## v1.1.3 (23 November 2026)

**Auto Typer: live input and output**
- The Auto Typer has three sources: *Text* (as before), *Voice* and *Screen*. The live ones show an **Input → Output** view: what came in on the left, what was typed on the right.
- **Voice**: press *Start dictating*, click into any text box, and speak. Each phrase is typed there with your typing settings. Sentences get capitals; say “comma”, “full stop”, “question mark”, “new line”, “new paragraph”; “delete that” removes the last phrase; “stop dictation” ends it.
- **Screen (beta)**: *Select region*, drag a rectangle over part of the screen, then *Start following*. NEXUS reads the text inside it every second with the recognition built into Windows (nothing leaves the PC) and types whatever newly appears into the text box you click in. A line is typed only after it has been read the same way twice, never twice, and a line that keeps growing (live captions) is followed.
- Either mode can also just collect the text in the output box instead of typing it into another app.

## v1.1.2 (23 November 2026)

**Calendar: zoom, depth and motion**
- Zoom in and out with the slider, Ctrl + wheel (the time under the pointer stays put), or `+` and `−`; `0` or *Fit day* fits the whole waking day again. The zoom level is remembered.
- Zoomed in, blocks have room for more: their length, checklist progress and notes, and the half and quarter hours are labelled.
- Blocks are raised, lit tiles with a shadow in their own colour; they lift under the pointer, the one under way breathes, finished ones sit flat, and the block being dragged lifts off the page.
- A hairline follows the pointer across the days and shows the time it points at.
- Switching view tips the new one into place; stepping through time slides the days in from the side you came from. Motion is reduced when Windows asks for less animation.

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
