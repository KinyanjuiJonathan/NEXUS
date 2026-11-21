/**
 * Update check and feedback. The app asks for the latest published release,
 * compares versions, and points the user at the download; installing over the
 * old version keeps all data. Feedback opens a prefilled issue on the
 * project's page (or an email), so nothing is sent without the user seeing it.
 */

export const REPO_URL = "https://github.com/KinyanjuiJonathan/NEXUS";

const parts = (v: string) => v.trim().replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);

/** 1 when `a` is newer than `b`, -1 when older, 0 when the same ("v1.2.0" and "1.2" compare equal). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) > 0;

export type FeedbackKind = "problem" | "idea" | "praise";
const KIND_LABEL: Record<FeedbackKind, string> = { problem: "Problem", idea: "Idea", praise: "What works well" };

export interface FeedbackInput {
  kind: FeedbackKind;
  text: string;
  /** Which part of NEXUS it is about (e.g. "Auto Typer"). */
  area: string;
  version: string;
  /** The version in use before the last update, when the feedback is about a change. */
  previousVersion?: string | null;
  platform?: string;
}

export function feedbackTitle(f: FeedbackInput): string {
  const first = f.text.trim().split("\n")[0].slice(0, 70);
  return `[${KIND_LABEL[f.kind]}${f.area ? ` · ${f.area}` : ""}] ${first}`;
}

export function feedbackBody(f: FeedbackInput): string {
  return [
    f.text.trim(),
    "",
    "---",
    `NEXUS ${f.version}${f.previousVersion && f.previousVersion !== f.version ? ` (updated from ${f.previousVersion})` : ""}`,
    f.area ? `Area: ${f.area}` : "",
    f.platform ? `System: ${f.platform}` : "",
  ]
    .filter((l, i) => i < 3 || l)
    .join("\n");
}

/** A prefilled "new issue" page for the feedback. */
export function feedbackUrl(f: FeedbackInput): string {
  const q = new URLSearchParams({ title: feedbackTitle(f), body: feedbackBody(f) });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}
