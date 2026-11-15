#!/usr/bin/env node
/**
 * vibeleak - prove what a stranger can read from an AI-built app.
 * Zero-dependency TypeScript CLI. Read-only: GET/HEAD only, limit=1,
 * never stores row values. Only scan apps you own or are authorised
 * to test in writing (flag --i-own-this-app).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runScan, loadEffectiveConfig, printSummary } from "./scan.js";
import { probeProject } from "./probe.js";
import { refuseKeyReason } from "./jwt.js";
import { evaluateVerdict, verdictFromFindings, findingLabel, type Finding } from "./verdict.js";
import {
  buildReport,
  loadConfig,
  loadReport,
  writeReport,
  type VibeleakConfig,
  type VibeleakReport,
} from "./report.js";
import { diffReports, diffFails } from "./baseline.js";

const VERSION = "0.1.0";

const USAGE = `vibeleak ${VERSION} - prove what a stranger can read from an AI-built app

USAGE
  vibeleak scan <app-url> [--i-own-this-app] [--out report.json]
                         [--config vibeleak.json] [--fail-on high]
                         [--tables a b]
  vibeleak probe --url <project-url> --anon-key <key> [--tables a b]
                         [--i-own-this-app] [--out report.json]
                         [--config vibeleak.json] [--fail-on high]
  vibeleak check [--report report.json] [--baseline baseline.json]
                         [--fail-on high] [--config vibeleak.json]
  vibeleak diff --baseline baseline.json [--report report.json]
  vibeleak init [--dir .]

CONSENT (hard rule)
  scan and probe only test apps you own or are authorised to test in
  writing. Pass --i-own-this-app (or set VIBELEAK_I_OWN_THIS_APP=1).
  Without it the command exits 2 and sends no request.

SAFETY
  Read-only: GET/HEAD only, limit=1 per table, at most one request per
  table and one per bucket. Only anon JWTs (role "anon") or
  sb_publishable_ keys are accepted; service_role / authenticated keys
  are refused before any request. Reports store column names and a 0/1
  rows-visible flag only - never row values.

EXIT CODES
  0 CLEAN   1 LEAK   2 input/consent error   3 REVIEW
`;

interface Flags {
  positional: string[];
  iOwnThisApp: boolean;
  out?: string;
  config?: string;
  failOn?: "critical" | "high" | "medium" | "low";
  url?: string;
  anonKey?: string;
  tables: string[];
  report?: string;
  baseline?: string;
  dir: string;
}

const VALUE_FLAGS = new Set([
  "--out",
  "--config",
  "--fail-on",
  "--url",
  "--anon-key",
  "--report",
  "--baseline",
  "--dir",
]);

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    positional: [],
    iOwnThisApp: false,
    tables: [],
    dir: ".",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--i-own-this-app") {
      flags.iOwnThisApp = true;
    } else if (arg === "--tables") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags.tables.push(argv[++i]);
      }
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`flag ${arg} needs a value`);
      }
      switch (arg) {
        case "--out":
          flags.out = value;
          break;
        case "--config":
          flags.config = value;
          break;
        case "--fail-on":
          if (value !== "critical" && value !== "high" && value !== "medium" && value !== "low") {
            throw new Error(`--fail-on must be critical|high|medium|low, got ${value}`);
          }
          flags.failOn = value;
          break;
        case "--url":
          flags.url = value;
          break;
        case "--anon-key":
          flags.anonKey = value;
          break;
        case "--report":
          flags.report = value;
          break;
        case "--baseline":
          flags.baseline = value;
          break;
        case "--dir":
          flags.dir = value;
          break;
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function consentGiven(flags: Flags): boolean {
  return flags.iOwnThisApp || process.env.VIBELEAK_I_OWN_THIS_APP === "1";
}

function requireConsent(flags: Flags): boolean {
  if (consentGiven(flags)) return true;
  console.error(
    "error: consent required. Only scan apps you own or are authorised to test in writing.",
  );
  console.error(
    "Pass --i-own-this-app (or set VIBELEAK_I_OWN_THIS_APP=1) to confirm. No request was sent.",
  );
  return false;
}

function loadConfigOrDefault(flags: Flags): VibeleakConfig {
  const config = loadEffectiveConfig(flags.config);
  if (flags.failOn) config.failOn = flags.failOn;
  return config;
}

async function cmdProbe(flags: Flags): Promise<number> {
  if (!requireConsent(flags)) return 2;
  if (!flags.url || !flags.anonKey) {
    console.error("error: probe needs --url <project-url> and --anon-key <key>");
    return 2;
  }
  const refusal = refuseKeyReason(flags.anonKey);
  if (refusal !== null) {
    console.error(`error: ${refusal}`);
    return 2;
  }
  const config = loadConfigOrDefault(flags);
  const outcome = await probeProject({
    projectUrl: flags.url,
    anonKey: flags.anonKey,
    tables: flags.tables.length > 0 ? flags.tables : undefined,
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
    appUrl: null,
    projectUrl: flags.url,
    verdict,
    findings,
    tables: outcome.tables,
    buckets: outcome.buckets,
    enumerated: outcome.enumerated,
    notes: outcome.notes,
  });
  if (flags.out) {
    writeReport(flags.out, report);
    console.log(`report written: ${flags.out}`);
  }
  printSummary(report, outcome.tables.length);
  return exitCode;
}

function regressionFindings(baseline: VibeleakReport, report: VibeleakReport): Finding[] {
  const findings: Finding[] = [];
  for (const table of report.tables) {
    if (table.status !== "leak") continue;
    const base = baseline.tables.find((t) => t.name === table.name);
    if (base === undefined) {
      findings.push({
        rule: "REGRESSION",
        severity: "high",
        kind: "regression",
        subject: table.name,
        message: "new leak: table is not in the baseline and anonymous GET returns rows",
        rowsVisible: table.rowsVisible,
        columns: table.columns,
      });
    } else if (base.status === "clean" || base.status === "allowlisted") {
      findings.push({
        rule: "REGRESSION",
        severity: "high",
        kind: "regression",
        subject: table.name,
        message: `regression: table was ${base.status} in the baseline and now leaks`,
        rowsVisible: table.rowsVisible,
        columns: table.columns,
      });
    }
  }
  for (const bucket of report.buckets) {
    if (bucket.status !== "leak") continue;
    const base = baseline.buckets.find((b) => b.name === bucket.name);
    if (base === undefined || base.status === "clean" || base.status === "allowlisted") {
      findings.push({
        rule: "REGRESSION",
        severity: "high",
        kind: "regression",
        subject: bucket.name,
        message:
          base === undefined
            ? "new leak: bucket is not in the baseline and anonymous listing is allowed"
            : `regression: bucket was ${base.status} in the baseline and now leaks`,
      });
    }
  }
  return findings;
}

async function cmdCheck(flags: Flags): Promise<number> {
  const reportPath = flags.report ?? "report.json";
  let report: VibeleakReport;
  try {
    report = loadReport(reportPath);
  } catch (err) {
    console.error(`error: cannot read report ${reportPath}: ${(err as Error).message}`);
    return 2;
  }
  const failOn =
    flags.failOn ??
    (flags.config ? loadConfig(flags.config).failOn : undefined) ??
    (existsSync("vibeleak.json") ? loadConfig("vibeleak.json").failOn : "high");
  let findings: Finding[] = [...report.findings];
  let baseline: VibeleakReport | null = null;
  if (flags.baseline) {
    try {
      baseline = loadReport(flags.baseline);
    } catch (err) {
      console.error(`error: cannot read baseline ${flags.baseline}: ${(err as Error).message}`);
      return 2;
    }
    findings = [...findings, ...regressionFindings(baseline, report)];
  }
  const { verdict, exitCode } = verdictFromFindings(findings, failOn);
  console.log(`checking ${reportPath}${baseline ? ` against baseline ${flags.baseline}` : ""} ...`);
  if (findings.length > 0) {
    console.log("findings:");
    for (const f of findings) {
      const detail =
        f.kind === "table" && f.rowsVisible !== undefined
          ? ` (${f.rowsVisible} row visible, columns: ${(f.columns ?? []).join(", ")})`
          : "";
      console.log(`  ${findingLabel(f)}: ${f.subject}${detail} - ${f.message}`);
    }
  }
  for (const t of report.tables) {
    if (t.allowlisted && t.rowsVisible >= 1) {
      console.log(`${t.name} still public by design (allowlisted)`);
    }
  }
  if (baseline) {
    const regressions = findings.filter((f) => f.kind === "regression");
    if (regressions.length === 0) console.log("no regressions vs baseline");
  }
  if (verdict === "CLEAN") {
    console.log("verdict: CLEAN - anonymous read clean (not a full audit; see Honest limits)");
  } else if (verdict === "LEAK") {
    console.log("verdict: LEAK - an anonymous visitor can read data (exit 1)");
  } else {
    console.log("verdict: REVIEW - could not fully prove the anonymous view (exit 3)");
  }
  return exitCode;
}

async function cmdDiff(flags: Flags): Promise<number> {
  if (!flags.baseline) {
    console.error("error: diff needs --baseline baseline.json");
    return 2;
  }
  const reportPath = flags.report ?? "report.json";
  let baseline: VibeleakReport;
  let report: VibeleakReport;
  try {
    baseline = loadReport(flags.baseline);
  } catch (err) {
    console.error(`error: cannot read baseline ${flags.baseline}: ${(err as Error).message}`);
    return 2;
  }
  try {
    report = loadReport(reportPath);
  } catch (err) {
    console.error(`error: cannot read report ${reportPath}: ${(err as Error).message}`);
    return 2;
  }
  const entries = diffReports(baseline, report);
  for (const e of entries) {
    const tag =
      e.change === "fixed"
        ? " (fixed)"
        : e.change === "regression"
          ? " (regression)"
          : e.change === "new-leak"
            ? " (new leak)"
            : "";
    console.log(`${e.name}: ${e.from.toUpperCase()} -> ${e.to.toUpperCase()}${tag}`);
  }
  const fixed = entries.filter((e) => e.change === "fixed").length;
  const newLeaks = entries.filter((e) => e.change === "new-leak").length;
  const regressions = entries.filter((e) => e.change === "regression").length;
  console.log(`${fixed} fixed, ${newLeaks} new leaks, ${regressions} regressions`);
  return diffFails(entries) ? 1 : 0;
}

const SAMPLE_CONFIG: VibeleakConfig & { note: string } = {
  version: 1,
  projectUrl: "https://YOUR-PROJECT-REF.supabase.co",
  publicTables: ["public_posts"],
  publicBuckets: ["public-assets"],
  failOn: "high",
  maxTables: 50,
  note: "Tables in publicTables are intentionally readable by anonymous visitors. Only add a table here when public reads are the design, not an accident.",
};

function cmdInit(flags: Flags): number {
  const dir = flags.dir;
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "vibeleak.json");
  const baselinePath = join(dir, "vibeleak.baseline.json");
  let wrote = 0;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(SAMPLE_CONFIG, null, 2) + "\n", "utf8");
    console.log(`wrote ${configPath}`);
    wrote++;
  } else {
    console.log(`${configPath} already exists, left unchanged`);
  }
  if (!existsSync(baselinePath)) {
    const emptyBaseline: VibeleakReport = {
      version: 1,
      tool: "vibeleak",
      generatedAt: new Date().toISOString(),
      appUrl: null,
      projectUrl: "",
      verdict: "CLEAN",
      findings: [],
      tables: [],
      buckets: [],
      enumerated: false,
      notes: ["Empty baseline created by vibeleak init. Run vibeleak scan to fill it in."],
    };
    writeFileSync(baselinePath, JSON.stringify(emptyBaseline, null, 2) + "\n", "utf8");
    console.log(`wrote ${baselinePath}`);
    wrote++;
  } else {
    console.log(`${baselinePath} already exists, left unchanged`);
  }
  if (wrote === 0) console.log("nothing to do: both files already exist");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`vibeleak ${VERSION}`);
    return 0;
  }
  const command = argv[0];
  let flags: Flags;
  try {
    flags = parseArgs(argv.slice(1));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  switch (command) {
    case "scan": {
      if (flags.positional.length !== 1) {
        console.error("error: scan takes exactly one <app-url>");
        return 2;
      }
      if (!requireConsent(flags)) return 2;
      const { exitCode } = await runScan({
        appUrl: flags.positional[0],
        outPath: flags.out,
        configPath: flags.config,
        failOn: flags.failOn,
        tables: flags.tables.length > 0 ? flags.tables : undefined,
      });
      return exitCode;
    }
    case "probe":
      return cmdProbe(flags);
    case "check":
      return cmdCheck(flags);
    case "diff":
      return cmdDiff(flags);
    case "init":
      return cmdInit(flags);
    default:
      console.error(`error: unknown command ${command}`);
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
