/**
 * Baseline diff: compare a current report against a baseline report
 * (a prior report). Labels each table/bucket as fixed, regressed,
 * newly leaking, still leaking, or unchanged.
 */
import type { VibeleakReport } from "./report.js";

export type DiffChange =
  "fixed" | "regression" | "new-leak" | "still-leaking" | "still-clean" | "new-clean" | "unchanged";

export interface DiffEntry {
  kind: "table" | "bucket";
  name: string;
  from: string;
  to: string;
  change: DiffChange;
}

function statusOf(report: VibeleakReport, kind: "table" | "bucket", name: string): string | null {
  const list = kind === "table" ? report.tables : report.buckets;
  const hit = list.find((e) => e.name === name);
  return hit ? hit.status : null;
}

export function diffReports(baseline: VibeleakReport, current: VibeleakReport): DiffEntry[] {
  const names = new Map<string, "table" | "bucket">();
  for (const t of baseline.tables) names.set(`table:${t.name}`, "table");
  for (const b of baseline.buckets) names.set(`bucket:${b.name}`, "bucket");
  for (const t of current.tables) names.set(`table:${t.name}`, "table");
  for (const b of current.buckets) names.set(`bucket:${b.name}`, "bucket");

  const entries: DiffEntry[] = [];
  for (const [key, kind] of [...names.entries()].sort()) {
    const name = key.slice(key.indexOf(":") + 1);
    const from = statusOf(baseline, kind, name);
    const to = statusOf(current, kind, name);
    if (from === null && to === null) continue;
    const fromLabel = from ?? "absent";
    const toLabel = to ?? "absent";
    let change: DiffChange;
    if (from === "leak" && to === "clean") change = "fixed";
    else if (from === "leak" && (to === "allowlisted" || to === "unknown")) change = "fixed";
    else if ((from === "clean" || from === "allowlisted") && to === "leak") change = "regression";
    else if (from === null && to === "leak") change = "new-leak";
    else if (from === "leak" && to === "leak") change = "still-leaking";
    else if (from === null && to !== "leak") change = "new-clean";
    else if (from === to) change = "still-clean";
    else change = "unchanged";
    entries.push({ kind, name, from: fromLabel, to: toLabel, change });
  }
  return entries;
}

/** A diff fails CI when any table/bucket newly leaks or regresses. */
export function diffFails(entries: DiffEntry[]): boolean {
  return entries.some((e) => e.change === "regression" || e.change === "new-leak");
}
