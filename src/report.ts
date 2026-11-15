/**
 * Report and config file shapes. A report records column NAMES and a
 * 0/1 rows-visible flag only - never row values. A baseline is a prior
 * report used for regression checks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Finding, Verdict } from "./verdict.js";

export interface TableReport {
  name: string;
  rowsVisible: number;
  columns: string[];
  allowlisted: boolean;
  status: "leak" | "clean" | "allowlisted" | "unknown";
}

export interface BucketReport {
  name: string;
  listable: boolean;
  allowlisted: boolean;
  status: "leak" | "clean" | "allowlisted" | "unknown";
}

export interface VibeleakReport {
  version: 1;
  tool: "vibeleak";
  generatedAt: string;
  appUrl: string | null;
  projectUrl: string;
  verdict: Verdict;
  findings: Finding[];
  tables: TableReport[];
  buckets: BucketReport[];
  enumerated: boolean;
  notes: string[];
}

export interface VibeleakConfig {
  version: 1;
  projectUrl?: string;
  publicTables: string[];
  publicBuckets: string[];
  failOn: "critical" | "high" | "medium" | "low";
  maxTables: number;
}

export const DEFAULT_CONFIG: VibeleakConfig = {
  version: 1,
  publicTables: [],
  publicBuckets: [],
  failOn: "high",
  maxTables: 50,
};

export function loadConfig(path: string): VibeleakConfig {
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config ${path} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  return {
    version: 1,
    projectUrl: typeof obj.projectUrl === "string" ? obj.projectUrl : undefined,
    publicTables: Array.isArray(obj.publicTables)
      ? obj.publicTables.filter((t): t is string => typeof t === "string")
      : [],
    publicBuckets: Array.isArray(obj.publicBuckets)
      ? obj.publicBuckets.filter((t): t is string => typeof t === "string")
      : [],
    failOn:
      obj.failOn === "critical" ||
      obj.failOn === "high" ||
      obj.failOn === "medium" ||
      obj.failOn === "low"
        ? obj.failOn
        : "high",
    maxTables:
      typeof obj.maxTables === "number" && obj.maxTables > 0 ? Math.floor(obj.maxTables) : 50,
  };
}

export function loadReport(path: string): VibeleakReport {
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`report ${path} is not a JSON object`);
  }
  return parsed as VibeleakReport;
}

export function writeReport(path: string, report: VibeleakReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

export function buildReport(input: {
  appUrl: string | null;
  projectUrl: string;
  verdict: Verdict;
  findings: Finding[];
  tables: TableReport[];
  buckets: BucketReport[];
  enumerated: boolean;
  notes: string[];
}): VibeleakReport {
  return {
    version: 1,
    tool: "vibeleak",
    generatedAt: new Date().toISOString(),
    appUrl: input.appUrl,
    projectUrl: input.projectUrl,
    verdict: input.verdict,
    findings: input.findings,
    tables: input.tables,
    buckets: input.buckets,
    enumerated: input.enumerated,
    notes: input.notes,
  };
}
