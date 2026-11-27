# NEXUS update history

NEXUS stays on version 1: every release is a 1.x.y number, raised by one step each time. Installing any release over an older one keeps your tasks, schedule, history and settings (they live in `%APPDATA%\com.nexus.productivity`, which the installer never touches, and the database is backed up before any change to its format).

## v1.1.24 (27 November 2026)

**Captured tables are listed row by row under their headings**
- **A table is written as a list.** Instead of one tab-separated line per row, each row of a table is now written out under the table's own headings:

  ```
  Behavioral Issue:
  Code Hallucinations

  Description:
  Invents or assumes existence of functions, APIs, libraries, …

  Example of what to watch for:
  Invents a method on a real class; invents API functions; …

  What to document:
  The specific hallucinated code element and what actually exists, …


  Behavioral Issue:
  Documentation Issues

  Description:
  …
  ```

  One blank line between the fields of a row, two between rows. The heading row is not written on its own. A cell that is empty is left out.
- **The same table continues under the same headings.** When you scroll down and capture the next part of a table, NEXUS lines the capture up with the rows it already has (the overlap) and recognises that it is still in the same table, so the new rows get the same headings, even though the header row is no longer on screen. A table that starts right at the top edge of the region, with nothing above it, is treated as one that was scrolled into, never as a new table.
- **A new table gets its own headings.** A table that begins after other text, or has a different number of columns, starts afresh with its first row as the headings.
- **A row cut off by the edge** is still completed by the next capture, as in v1.1.23.
- If only the heading row of a table is in view, it is shown as one line until a row is captured; it then turns into the headings of that row.
- **Unchanged:** everything that is not a table (paragraphs, headings, lists, indentation, paragraph gaps) is captured exactly as before, and captured text is still only added to.

## v1.1.23 (27 November 2026)

**Screen capture understands tables**
- **Tables are captured as tables.** Before, a table was read straight across: the first line of every cell, then the second line of every cell, so the columns were mixed together. Now NEXUS recognises the columns and rebuilds the table:
  - one line of text per table row;
  - each cell's text kept together, however many lines it has in the cell (a word split with a hyphen at the end of a line is joined again);
  - a **tab** between cells, and an empty place for an empty cell.
- **What you can do with it.** Copy the text and paste it into Excel, Google Sheets or a table in Word: every cell lands in its own cell. In the text box the cells of a row appear separated by wide gaps.
- **Coloured header rows are read.** Light text on a coloured band (a table's header row, a button) is turned into dark text on white before reading, like the rest of the picture.
- **A row cut off by the edge is completed.** If the bottom of the region slices through a table row, that row is captured as far as it shows. When the next capture shows the whole row, its cells are filled in, and nothing is repeated. This is the one case where captured text is added to in place.
- **Everything else is unchanged.** Ordinary text, headings, indentation and paragraph gaps are captured as before. A label with its value on the same line, or a paragraph, is not treated as a table: a table needs at least two columns and at least two rows with text in more than one of them.
- How it decides: text that starts at the same few horizontal positions over several rows is a table; inside a cell the lines are close together, and a new row begins after a larger gap with text in several columns.
- Limits: merged cells and tables without clear gaps between columns may come out with cells shifted. Send me a screenshot when that happens.

## v1.1.22 (27 November 2026)

**Screen capture: numbers no longer read as letters**
- **Fixed: "10" was captured as "IO".** In many screen fonts a one looks like a capital I or a small L, and a nought like a capital O, so the recogniser sometimes returns letters for a number. Captured text is now checked for that in three ways:
  - **Two readings.** Each capture is already read twice. Where the readings of a line differ only in this way and one of them saw a plain number, the number is used.
  - **Mixed digits and look-alikes.** A word made only of digits and look-alikes, with at least one real digit, is a number: "1O" → 10, "l0" → 10, "2O24" → 2024, "1OO" → 100, "1Oth" → 10th.
  - **Look-alikes where a number is expected.** "IO", "lOO", "IOOO" become 10, 100, 1000 when they follow a word that introduces a number, such as "at", "of", "than", "to", "limit", "every" ("full at IO" → "full at 10").
- **Left alone on purpose:** "I/O", and "IO" where nothing suggests a number ("the IO layer"). Words, names and codes with other letters in them are never touched.
- The limit of this: a lone "IO" after a word that is not on the list stays as it was read, because it cannot be told from the abbreviation. Tell me the phrases where that happens and I will add them.

## v1.1.21 (27 November 2026)

**Screen capture reads right up to the edges**
- **Fixed: lines at the edges of the reading region were missed.** Two things caused it:
  - Text recognition skips or misreads text that touches the border of the picture it is given. The capture now gets a band of white space on every side before it is read, so the first and last lines, and text against the left or right side, are read like the rest.
  - NEXUS itself left out any line whose box touched the top or bottom edge, to avoid half-cut lines. That was too strict and dropped whole lines too. Now a line is only left out when the edge really cuts through it (it touches the edge and is clearly shorter than the other lines); a whole line against the edge is kept.
- The frame's outline now sits one pixel further from the region, so it cannot show up in the capture as a stray mark at the edge.
- A line that is sliced in half by the edge is still left for the next capture, so it is picked up whole after you scroll or enlarge the region.

## v1.1.20 (27 November 2026)

**Screen capture reads grey text, links and small text**
- **Fixed: parts of a form were missing or garbled.** Capturing a region skipped light-grey text (hints under a label, placeholder text and values inside fields, such as "C#"), turned an underlined link into nonsense, and misread small help text.
- The captured picture is now prepared before it is read:
  - every pixel is compared with the background around it, so grey text in a white field, text in a grey field, and coloured links all become dark text on white;
  - light text on a dark page is turned into dark on light;
  - thin horizontal rules (the underline of a link, the border of a field) are taken out, so they are not read as part of the letters;
  - the picture is enlarged smoothly, up to three times, instead of by doubling each pixel.
- The region is read twice, once with faint text strengthened and once more gently, and lines that only one reading finds are kept. A capture therefore takes a little longer than before.
- Nothing else about the reading region changed: it still reads only on a right-click, and captured text is still only added to.
- For the best results: capture at 100% zoom or larger (Ctrl + plus in a browser makes small text much easier to read), and keep the region to the part you need.
- Still not possible: text inside a field that scrolls sideways is only read as far as it is visible, so a long link that is cut off by the edge of its field is captured cut off.

## v1.1.19 (26 November 2026)

**Reading region: move, resize, right-click to capture**
- **A region you place yourself.** Auto Typer → Text → **Reading region** puts a thin frame on the screen, where it was last time. Drag its small bar to move it anywhere, on any monitor. Drag an edge or a corner to resize it. Its place and size are remembered.
- **Right-click to capture, and only then.** Nothing is scanned, read or extracted while the region is simply open, moved or resized. Text is read once each time you right-click inside the region. That right-click is taken by NEXUS, so the app underneath does not show its own menu.
- **The window underneath stays usable.** Inside the region, ordinary clicks and scrolling go straight through to the app below, so you can scroll to the next section and right-click again.
- **Close it when you are done.** Press **×** on the frame's bar, or **Close region** in NEXUS. The frame disappears and the mouse watcher stops; nothing can be captured until you open the region again.
- **Captured text is never changed.** Each capture is lined up with what was captured before, and only the new lines are added: after the earlier text, or in front of it when the new section comes from above. Lines already captured are left exactly as they are, even when they are read slightly differently a second time, and nothing is added twice. Capturing the same place again adds nothing.
- **Your edits are kept.** If you change the captured text in the box between captures, your changes are not overwritten: the new lines are added at the end. Text you had in the box before starting stays where it is.
- **Layout is kept** as before: indentation, paragraph gaps, text on the same row, and larger text as headings. Lines cut in half by the top or bottom edge of the region are left out of that capture and picked up whole by the next one.
- The frame says what each capture did ("+3 lines captured", "Nothing new here", "No text found"), and so does the row above the text box in NEXUS.
- Replaces the automatic "Extract from screen… Stop" reading of v1.1.17 and v1.1.18.

## v1.1.18 (26 November 2026)

**Screen extraction inside the Text box**
- **One text box.** The separate Screen tab, with its reading panel and output area, is gone. Extraction now lives in the Text section of the Auto Typer, as one row above the text box: **Extract from screen**, **Change region** and **Copy**.
- **Extract first, until you press Stop.** Press Extract from screen (the first time you mark the region on the way), scroll the other window, and press **Stop** when you have everything. Nothing is typed anywhere during extraction; the text is only collected in the box.
- **Then copy or type.** The extracted text is in the same box you normally type from: edit it, press **Copy**, or press **Start** to have it typed into another app. Start is unavailable while an extraction is running.
- The row shows what is happening: "Extracting…", how many new lines the last reading added and the total so far. The region is still outlined on the screen while it is read.
- Unchanged from v1.1.17: text is followed as you scroll, nothing already scanned is taken again, and indentation, paragraph gaps and headings are kept.

## v1.1.17 (26 November 2026)

**Screen text extraction that follows your scrolling**
- **Extract while scrolling.** In Auto Typer → Screen, select a region, press **Start extracting** and scroll the other window. Each reading is laid over what was read before: the overlapping part is recognised and skipped, and only the new text is added. Scrolling back up, or stopping on the same view, adds nothing.
- **No repeats.** Text that was already scanned is not taken again, even when a few characters are misread the second time. Lines that genuinely repeat in the source (a closing bracket, a repeated sentence) are kept, because lines are matched by their place in the text, not just their wording. After a jump to a different part of the page, only text not read before is added.
- **You can see what it is working on.** The region is outlined on the screen itself with a labelled frame that pulses while reading and flashes green when new text is taken; clicks and scrolling pass straight through it. In NEXUS, the "Reading this part of the screen" box shows the current reading with new lines in green and lines already extracted in grey, and a count of lines extracted.
- **Output goes to the editing pad.** The extracted text is written into the normal Auto Typer pad as it comes in (after any text already there). Editing is paused while extracting and free again afterwards.
- **Same layout as the source.** Indentation, paragraph gaps, text on the same row, and larger text (as headings) are kept. Bold, italic, colours and fonts cannot be recognised from a screen image, so those are not reproduced.
- **Then type it elsewhere.** **Mark done** ends the extraction. Check or edit the text, then **Type it into another app** types it with your usual rhythm settings. **Continue** carries on the same extraction; **New extraction** starts another one.
- Replaces the earlier Screen mode, which typed new lines straight into another app as they appeared.
- Tip: scroll in steps that leave a few lines of the previous view visible. That overlap is what lets NEXUS know where it is.

## v1.1.16 (26 November 2026)

**Full-screen calendar with a compact toolbar**
- **The calendar fills the window.** It now uses the full width and runs to the bottom of the window in Day, Week, Month and Agenda, instead of sitting in a narrower column with the page scrolling under it. The page title, the legend row and the paragraph of tips no longer take space around it.
- **One line of controls instead of two.** Left: previous / Today / next, the date (click it to jump to a date) and Day · Week · Month · Agenda. Right: a search icon that opens when clicked (or press /), then three menus and **New**.
- **Filter** menu: All, Tasks, Appointments, Overdue, Completed. The button shows the filter in use.
- **View** menu: the time zone the calendar is shown in, zoom and "Fit day", Time zone & working hours, Daily routine, the legend and the short tips.
- **Plan** menu: Auto-plan, Reschedule all and AI Schedule.
- Nothing was removed: every control is still there, and the keyboard shortcuts (T, D, W, M, ←/→, /, + and −) work as before. On a narrow window the menu buttons shrink to icons.

## v1.1.15 (26 November 2026)

**Wallpaper effect: easy to turn off or re-time**
- The wallpaper effect (ambient mode, where NEXUS drifts between pages when left alone) now has its own section in Settings, **Wallpaper effect (ambient mode)**, right under Appearance, with a clear on/off switch.
- **Your own timing.** Type the number of minutes without input before it starts (1 to 240) and the seconds it stays on each page (10 to 3600), instead of choosing from a short list. Four quick choices set both at once: Soon · quick, Balanced, Calm and Rarely.
- **Turn off from where it happens.** The first time the effect runs after NEXUS starts, a notice explains what it was, says where its settings are, and has a **Turn off** button.
- Choosing the pages and "Preview now" are unchanged.

## v1.1.14 (25 November 2026)

**New tasks are scheduled automatically**
- **Every new task gets a time.** When you add a task without giving it a start time, NEXUS reserves the soonest free time in your working hours for it, before its deadline. Before, this only happened for tasks that had an estimated duration; a task without one now gets one hour.
- **The deadline comes first.** If your working hours have no room before the deadline, the soonest free time at any hour is used instead (still around fixed appointments and your personal time), and the notice says so. Only when there is no free time at all before the deadline is the task placed after it, with a warning.
- The notice shows the time chosen and has **Undo**. Existing tasks and appointments are never moved to make room. Long tasks are still split into blocks as before.
- The setting is now called "Schedule new tasks automatically" (Settings → Smart scheduling) and can be turned off.

## v1.1.13 (25 November 2026)

**One-click updates; more time for overdue tasks**
- **Fewer pop-ups when updating.** The "new version is available" notice now has **Install now**. NEXUS downloads the installer from its own releases page, checks it against the checksum published for it, and runs it in passive mode: a progress bar and nothing to click (no welcome, folder or finish pages, no "close NEXUS first" question). NEXUS closes, updates and opens again by itself, with your data kept. If the download or the check fails, nothing is installed and the notice offers the download page instead.
- This starts working for the update *after* this one: you still install v1.1.13 the usual way, and later versions can be installed with one click. Running the installer by hand still shows its normal pages.
- **Extend a task that ran out of time.** Overdue tasks get an **Extend** button (the queue, the task list, and "Missed" on the Dashboard): +15 min, +30 min, +1 hour, +2 hours or +3 hours, counted from now. The task's block is extended to then, it stops being overdue, and the tasks after it move along in the same order. An overdue task that never had time reserved gets a block starting now.
- Extending now keeps the work clock honest: time already clocked stays, and the time added is what is left to do.

## v1.1.12 (25 November 2026)

**Calendar opens at now; continuous system graph**
- **Calendar goes to the current time by default.** Opening the Calendar shows today with the current-time line in view, about a third of the way down, so what is under way and what comes next are both visible. Before, a zoomed-in calendar opened in the early morning. **Today** (or the T key) returns to today and the current time from anywhere.
- **The System Monitor graph is continuous.** It used to stop recording when you left the Dashboard and start empty when you came back. It now keeps recording on every page while NEXUS is open, so the graph continues from its history (the last minute, as before). Recording still pauses while the window is hidden, and the "Show system monitor" setting still turns it off completely.

## v1.1.11 (25 November 2026)

**Deadline glow removed**
- Removed the deadline visual effects added in v1.1.10: the amber/orange/red glow and moving light on task rows, the queue and calendar blocks, the flame icons and "time left" chips, the line along the bottom of rows, and the Deadline radar strip on the Dashboard and Calendar.
- Unchanged: overdue tasks are still shown in red with the warning icon, and due times still show "Due in …" as before. Extend, Repeat and ambient mode stay.
- The installer is still published as both `NEXUS_x.y.z_x64-setup.exe` (the usual one) and `.msi`.

## v1.1.10 (25 November 2026)

**Extend, repeat, deadline glow and ambient mode**
- **Extend a task.** The task under way (Dashboard), any task in the queue (open its row), gets an **Extend** button: +15 min, +30 min, +1 hour, +2 hours or +3 hours. Its block grows by that much and the tasks after it move along in the same order. One notice lists what moved, with Undo. A block whose time has already passed is extended from now. Fixed appointments are never moved; you are told if the extension runs into one.
- **Repeat a task.** The **Repeat** button (task rows, the queue, the current task) adds one more session as long as the last one. *Right after* puts it straight after the task's current time, or now, and moves later tasks along. *Next free time* finds a gap and moves nothing. A finished task is repeated as a new open task with the same details and an unticked checklist. Undo removes it again.
- **Deadline glow.** A task heats up as its deadline comes closer: amber and slow within a day, orange and quicker within two hours, red and fast once late. It is also orange when the time reserved for it ends after its deadline. The same glow, running light and flame icon appear on task rows, the queue, calendar blocks, the calendar's task chips and the agenda. A thin line along the bottom of a row fills as the last day runs out.
- **Deadline radar.** A strip on the Dashboard and above the Calendar lists the tasks that are running out, most urgent first, each with a ring that empties as time goes. It is hidden when nothing is close.
- **Ambient mode.** After 3 minutes without mouse or keyboard, NEXUS moves between Dashboard, Calendar, Tasks, World Clocks and Insights every 30 seconds, with slow, varied transitions and soft moving light behind the page. Moving the mouse or pressing a key returns you to the page you were on. It never starts with a dialog open, while a field has the cursor, or from Accounts, the Auto Typer, the Assistant or Settings. Settings → Appearance: turn it off, choose the idle time, the time per page and the pages, or preview it.
- With "Reduce motion" on, deadline levels are shown as a steady coloured outline and ambient transitions are plain.

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
