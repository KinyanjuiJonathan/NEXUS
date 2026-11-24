# NEXUS update history

NEXUS stays on version 1: every release is a 1.x.y number, raised by one step each time. Installing any release over an older one keeps your tasks, schedule, history and settings (they live in `%APPDATA%\com.nexus.productivity`, which the installer never touches, and the database is backed up before any change to its format).

## v1.1.9 (24 November 2026)

**A rescheduled task is no longer overdue**
- **Fixed:** an overdue task that you dragged to a later time kept its old due time, so it stayed in Overdue (and in the red count on Tasks) even though it had a new plan.
- When you give an overdue task a new time that is still ahead, its due time now moves to the end of that new time. It leaves Overdue in the task list, the dashboard, the calendar and the pop-up, and its reminders follow the new time. A short notice confirms it.
- This applies however you move it: dragging or resizing on the calendar, editing the time, reordering the queue, Start now, the +15 min to +2 h buttons, and "reschedule all".
- Not changed: a deadline that has not passed yet stays exactly as you set it when you move the task, and a task moved to another time that is also in the past stays overdue. Moves NEXUS makes by itself do not change due times.

## v1.1.8 (24 November 2026)

**Time saved goes to what is next**
- **Finishing early frees the rest of the block.** When you mark a task complete while its block is still running, the block ends at that moment, so the calendar shows the time really used.
- **What was next comes forward.** The flexible tasks that follow move up to use the time saved, in the same order, each straight after the one before. The next task starts at the moment you finished.
- The same happens when a task is completed before its block has begun: the block is removed and the tasks after it move into its place.
- A notice says how much time was saved and shows each task's old and new time, with **Undo**.
- Not moved: fixed appointments, personal time (sleep, meals, gym), and tasks planned more than 18 hours ahead, so later days stay as you planned them. Nothing is ever moved later by this.

## v1.1.7 (24 November 2026)

**Accounts: managed accounts, taskers and money**
- **New Accounts area** in the side bar. It is locked until someone signs in, and locks again when you leave it.
- **Accounts.** Each managed account has a name, an owner, the owner's share of the profit (the rest is yours), a tax rate and a currency. One person can own several accounts, each with its own terms.
- **People.** Owners and taskers. A tasker can be assigned to one account or several, and can only be given tasks on accounts they are assigned to.
- **Projects and tasks.** A project is in one account at a time. It can be moved to another account, or copied so that another account has the same project. Tasks are given to a tasker at a fixed amount or an hourly rate, and go from assigned to in progress, submitted, approved and paid.
- **Money.** Per account and in total: revenue, tax, tasker pay, expenses, profit, the owner's share and yours, and what is still owed in tax, to owners and to taskers. A ledger records payments actually made. Amounts in different currencies are never added together.
- **Signing in.** The manager signs in with Windows Hello (fingerprint, face or PIN) or a passcode. Taskers sign in with their name and their own PIN and see only their own tasks, accounts and pay; the account's revenue and other people's figures are hidden from them. Passcodes and PINs are stored only in scrambled form.
- The module is self-contained (its own data layer, rules and money maths, all covered by tests) so that a separate taskers' interface can be added later on the same foundation. For now taskers sign in on this computer; signing in from their own devices needs a hosted server, which is not part of this release.
- Existing data is untouched: the update only adds a new table to the database, after the usual automatic backup.

## v1.1.6 (24 November 2026)

**Work clock counts only real work**
- **Fixed: more than 24 hours in a day, and counting while paused.** Two parts of NEXUS could start the work clock at the same moment (the idle check and an activity report, or a click and either), each opening a session. Only one of them was ever paused; the other kept counting around the clock, on top of the real one.
- Everything that starts, pauses, resumes or stops the clock now runs strictly one at a time, so a second session cannot be opened.
- Stray open sessions already in your data are closed when NEXUS starts, where their work really stopped; a pure duplicate counts for nothing. NEXUS tells you once when it has done this. Your real sessions are not changed.
- The same minute is never counted twice, so a day's total can never exceed the time that actually passed.
- As before, time is counted only while you are active: not while away from the keyboard, not on a break, not while the PC is locked or asleep, and not after clocking out.

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
