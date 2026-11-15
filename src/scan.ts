/**
 * `scan`: start from a deployed app URL only. Fetch the frontend like any
 * visitor, extract the Supabase project URL + anon key from shipped
 * JavaScript, then probe what an anonymous visitor can read.
 */
import { fetchFollowingRedirects, fetchWithTimeout } from "./http.js";
import { extractSecrets } from "./extract.js";
import { probeProject } from "./probe.js";
import { evaluateVerdict, verdictFromFindings, findingLabel, type Finding } from "./verdict.js";
import {
  buildReport,
  loadConfig,
  DEFAULT_CONFIG,
  writeReport,
  type VibeleakConfig,
  type VibeleakReport,
} from "./report.js";
import { existsSync } from "node:fs";

export interface ScanOptions {
  appUrl: string;
  outPath?: string;
  configPath?: string;
  failOn?: "critical" | "high" | "medium" | "low";
  tables?: string[];
}

export interface ScanResult {
  report: VibeleakReport;
  exitCode: number;
}

const MAX_JS_FILES = 10;
const MAX_JS_BYTES = 2 * 1024 * 1024;

const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;

export function collectScriptUrls(html: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_SRC_RE.exec(html)) !== null && urls.length < MAX_JS_FILES) {
    try {
      const resolved = new URL(match[1], baseUrl).toString();
      if (new URL(resolved).origin !== origin) continue;
      if (!urls.includes(resolved)) urls.push(resolved);
    } catch {
      continue;
    }
  }
  return urls;
}

export function loadEffectiveConfig(configPath?: string): VibeleakConfig {
  if (configPath) return loadConfig(configPath);
  if (existsSync("vibeleak.json")) return loadConfig("vibeleak.json");
  return { ...DEFAULT_CONFIG };
}

export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  const config = loadEffectiveConfig(opts.configPath);
  if (opts.failOn) config.failOn = opts.failOn;

  console.log(`scanning ${opts.appUrl} ...`);
  let fetched;
  try {
    fetched = await fetchFollowingRedirects(opts.appUrl, 3);
  } catch (err) {
    console.error(`error: could not fetch app URL: ${(err as Error).message}`);
    const report = buildReport({
      appUrl: opts.appUrl,
      projectUrl: "",
      verdict: "REVIEW",
      findings: [
        {
          rule: "V5",
          severity: "low",
          kind: "enum",
          subject: opts.appUrl,
          message: "app URL could not be fetched; nothing was probed",
        },
      ],
      tables: [],
      buckets: [],
      enumerated: false,
      notes: ["app fetch failed"],
    });
    if (opts.outPath) writeReport(opts.outPath, report);
    return { report, exitCode: 3 };
  }
  if (fetched.status !== 200) {
    console.error(`error: app URL returned HTTP ${fetched.status}`);
    const report = buildReport({
      appUrl: opts.appUrl,
      projectUrl: "",
      verdict: "REVIEW",
      findings: [
        {
          rule: "V5",
          severity: "low",
          kind: "enum",
          subject: opts.appUrl,
          message: `app URL returned HTTP ${fetched.status}; nothing was probed`,
        },
      ],
      tables: [],
      buckets: [],
      enumerated: false,
      notes: [`app fetch returned HTTP ${fetched.status}`],
    });
    if (opts.outPath) writeReport(opts.outPath, report);
    return { report, exitCode: 3 };
  }

  const sources: string[] = [fetched.text];
  const scriptUrls = collectScriptUrls(fetched.text, fetched.finalUrl);
  for (const scriptUrl of scriptUrls) {
    try {
      const res = await fetchWithTimeout(scriptUrl, { method: "GET" });
      if (res.status === 200 && res.text.length <= MAX_JS_BYTES) {
        sources.push(res.text);
      }
    } catch {
      continue;
    }
  }

  const extracted = extractSecrets(sources);
  if (extracted.projectUrl === null) {
    console.log("no Supabase project URL found in the shipped frontend");
    const report = buildReport({
      appUrl: opts.appUrl,
      projectUrl: "",
      verdict: "REVIEW",
      findings: [
        {
          rule: "V5",
          severity: "low",
          kind: "enum",
          subject: opts.appUrl,
          message:
            "no Supabase project URL found in shipped HTML/JavaScript; use probe with an explicit --url",
        },
      ],
      tables: [],
      buckets: [],
      enumerated: false,
      notes: ["no Supabase URL extracted"],
    });
    if (opts.outPath) writeReport(opts.outPath, report);
    printSummary(report);
    return { report, exitCode: 3 };
  }

  const anonKey = extracted.anonKey ?? extracted.publishableKey;
  console.log(`project: ${extracted.projectUrl} (Supabase URL found in shipped JavaScript)`);
  if (extracted.adminSecretFound) {
    const findings: Finding[] = evaluateVerdict({
      adminSecretFound: true,
      tables: [],
      buckets: [],
      enumerated: true,
      maxTablesExceeded: false,
    });
    const report = buildReport({
      appUrl: opts.appUrl,
      projectUrl: extracted.projectUrl,
      verdict: "LEAK",
      findings,
      tables: [],
      buckets: [],
      enumerated: true,
      notes: ["probe stopped before any table request: an admin key is shipped in the frontend"],
    });
    if (opts.outPath) writeReport(opts.outPath, report);
    printSummary(report);
    return { report, exitCode: 1 };
  }
  if (anonKey === null) {
    console.log("no anon key found in the shipped frontend");
    const report = buildReport({
      appUrl: opts.appUrl,
      projectUrl: extracted.projectUrl,
      verdict: "REVIEW",
      findings: [
        {
          rule: "V5",
          severity: "low",
          kind: "enum",
          subject: extracted.projectUrl,
          message:
            "no anon/publishable key found in shipped HTML/JavaScript; use probe with an explicit --anon-key",
        },
      ],
      tables: [],
      buckets: [],
      enumerated: false,
      notes: ["no anon key extracted"],
    });
    if (opts.outPath) writeReport(opts.outPath, report);
    printSummary(report);
    return { report, exitCode: 3 };
  }
  console.log(`anon key: found (role anon)`);

  const outcome = await probeProject({
    projectUrl: extracted.projectUrl,
    anonKey,
    tables: opts.tables,
    config,
  });
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: outcome.tables,
    buckets: outcome.buckets,
    enumerated: outcome.enumerated,
    maxTablesExceeded: outcome.maxTablesExceeded,
  });
  const { verdict, exitCode } = verdictFromFindings(findings, config.failOn);
  const report = buildReport({
    appUrl: opts.appUrl,
    projectUrl: extracted.projectUrl,
    verdict,
    findings,
    tables: outcome.tables,
    buckets: outcome.buckets,
    enumerated: outcome.enumerated,
    notes: outcome.notes,
  });
  if (opts.outPath) writeReport(opts.outPath, report);
  printSummary(report, outcome.tables.length);
  return { report, exitCode };
}

export function printSummary(report: VibeleakReport, tableCount?: number): void {
  if (report.tables.length > 0) {
    console.log(`tables: ${tableCount ?? report.tables.length} enumerated via OpenAPI`);
    for (const t of report.tables) {
      const cols = t.columns.length > 0 ? `, columns: ${t.columns.join(", ")}` : "";
      const allow = t.allowlisted ? " (allowlisted: public by design)" : "";
      console.log(`  ${t.name}: ${t.rowsVisible} row(s) visible${cols}${allow}`);
    }
  }
  if (report.buckets.length > 0) {
    console.log(`storage buckets: ${report.buckets.length}`);
    for (const b of report.buckets) {
      const state = b.listable ? "object listing allowed" : "not listable";
      const allow = b.allowlisted ? " (allowlisted)" : "";
      console.log(`  ${b.name}: ${state}${allow}`);
    }
  }
  if (report.findings.length > 0) {
    console.log("findings:");
    for (const f of report.findings) {
      const detail =
        f.kind === "table" && f.rowsVisible !== undefined
          ? ` (${f.rowsVisible} row visible, columns: ${(f.columns ?? []).join(", ")})`
          : "";
      console.log(`  ${findingLabel(f)}: ${f.subject}${detail} - ${f.message}`);
    }
  }
  for (const note of report.notes) {
    console.log(`note: ${note}`);
  }
  if (report.verdict === "CLEAN") {
    console.log("verdict: CLEAN - anonymous read clean (not a full audit; see Honest limits)");
  } else if (report.verdict === "LEAK") {
    console.log("verdict: LEAK - an anonymous visitor can read data (exit 1)");
  } else {
    console.log("verdict: REVIEW - could not fully prove the anonymous view (exit 3)");
  }
}
