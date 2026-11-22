/**
 * Loading saved data at start-up.
 *
 * The native side answers "still starting" while it opens the database (and,
 * in builds before this fix, "state not managed" when a window asked too
 * early). Neither means anything is wrong with the data: the load is simply
 * tried again until the database is open. Any other answer is a real failure
 * and goes to the recovery screen.
 */

export const STARTING = "NEXUS_STARTING";
export const UNAVAILABLE = "NEXUS_DATA_UNAVAILABLE";

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The native side is not ready yet: asking again shortly will work. */
export function isStarting(e: unknown): boolean {
  const m = text(e);
  return m.includes(STARTING) || /state not managed|\.manage\(\)/i.test(m);
}

/** The database could not be opened: recovery is needed. */
export function isUnavailable(e: unknown): boolean {
  return text(e).includes(UNAVAILABLE);
}

/** The message without the machine-readable prefix. */
export function plainError(e: unknown): string {
  return text(e).replace(new RegExp(`^(${STARTING}|${UNAVAILABLE}):?\\s*`), "").trim();
}

export interface RetryOptions {
  /** Give up after this long (ms). */
  timeoutMs?: number;
  /** First wait between tries (ms); it grows up to `maxDelayMs`. */
  delayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Run `load`, trying again for as long as the native side says it is still starting. */
export async function loadWhenReady<T>(load: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { timeoutMs = 60_000, delayMs = 120, maxDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = opts;
  const started = now();
  let delay = delayMs;
  for (;;) {
    try {
      return await load();
    } catch (e) {
      if (!isStarting(e)) throw e;
      if (now() - started >= timeoutMs) throw new Error("NEXUS took too long to open its database. Your data was not changed.");
      await sleep(delay);
      delay = Math.min(maxDelayMs, Math.round(delay * 1.5));
    }
  }
}

export type StartupProblem = "missing" | "unreadable" | "corrupt" | "newer";

export interface BackupInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedMs: number;
  tasks: number | null;
  events: number | null;
  valid: boolean;
}

export interface StartupStatus {
  state: "starting" | "ready" | "failed";
  problem: StartupProblem | null;
  message: string;
  dataDir: string;
  dbPath: string;
  dbExists: boolean;
  dbBytes: number;
  backups: BackupInfo[];
}

/** The backup to offer first: the newest one that passed its check and has something in it. */
export function bestBackup(backups: BackupInfo[]): BackupInfo | null {
  const usable = backups.filter((b) => b.valid && !b.name.startsWith("nexus-set-aside-"));
  return usable.find((b) => (b.tasks ?? 0) + (b.events ?? 0) > 0) ?? usable[0] ?? null;
}

/** What kind of backup a file is, from its name. */
export function backupKind(name: string): string {
  if (name.startsWith("nexus-auto-")) return "Daily backup";
  if (name.startsWith("nexus-recent-")) return "Recent backup";
  if (name.startsWith("nexus-manual-")) return "Manual backup";
  if (name.startsWith("nexus-pre-v")) return "Before an update";
  if (name.startsWith("nexus-before-restore-")) return "Before a restore";
  if (name.startsWith("nexus-before-import-")) return "Before an import";
  if (name.startsWith("nexus-set-aside-")) return "Set aside during recovery";
  return "Backup";
}
