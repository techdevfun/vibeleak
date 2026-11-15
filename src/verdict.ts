/**
 * Verdict rules V1-V6, evaluated in order. Every firing rule adds a
 * finding; the exit code follows the highest severity found.
 *
 * Severity order: critical > high > medium > low.
 * Exit codes: 0 CLEAN, 1 LEAK (a finding at or above --fail-on),
 * 2 input/consent error, 3 REVIEW (findings below --fail-on).
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "CLEAN" | "LEAK" | "REVIEW";
export type FailOn = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface Finding {
  rule: string;
  severity: Severity;
  kind: "secret" | "table" | "bucket" | "enum" | "regression";
  subject: string;
  message: string;
  rowsVisible?: number;
  columns?: string[];
}

/** Column names that mark a table as sensitive by name only (never values). */
export const SENSITIVE_COLUMN_NAMES = [
  "password",
  "secret",
  "ssn",
  "passport",
  "token",
  "api_key",
] as const;

export function isSensitiveColumnName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_COLUMN_NAMES.some((s) => lower.includes(s));
}

export interface TableVerdictInput {
  name: string;
  rowsVisible: number;
  columns: string[];
  allowlisted: boolean;
}

export interface BucketVerdictInput {
  name: string;
  listable: boolean;
  allowlisted: boolean;
}

/**
 * Evaluate V1-V6 over probe results. `adminSecretFound` is V1;
 * `enumerated` false is V5. Returns findings in rule order.
 */
export function evaluateVerdict(input: {
  adminSecretFound: boolean;
  tables: TableVerdictInput[];
  buckets: BucketVerdictInput[];
  enumerated: boolean;
  maxTablesExceeded: boolean;
}): Finding[] {
  const findings: Finding[] = [];

  // V1 - admin key shipped in the frontend bundle. Probing stops here.
  if (input.adminSecretFound) {
    findings.push({
      rule: "V1",
      severity: "critical",
      kind: "secret",
      subject: "shipped JavaScript",
      message:
        "service_role JWT or sb_secret_ key found in shipped JavaScript; it bypasses all Row Level Security",
    });
    return findings;
  }

  for (const table of input.tables) {
    if (table.rowsVisible >= 1 && !table.allowlisted) {
      // V2 - anonymous read of a table that is not intentionally public.
      findings.push({
        rule: "V2",
        severity: "high",
        kind: "table",
        subject: table.name,
        message: `anonymous GET returns ${table.rowsVisible} row(s); table is not allowlisted`,
        rowsVisible: table.rowsVisible,
        columns: table.columns,
      });
    } else if (table.rowsVisible >= 1 && table.allowlisted) {
      // V4 - allowlisted table still exposes a sensitive-looking column name.
      const sensitive = table.columns.filter((c) => isSensitiveColumnName(c));
      if (sensitive.length > 0) {
        findings.push({
          rule: "V4",
          severity: "medium",
          kind: "table",
          subject: table.name,
          message: `allowlisted table exposes sensitive-looking column(s): ${sensitive.join(", ")}`,
          rowsVisible: table.rowsVisible,
          columns: table.columns,
        });
      }
    }
  }

  for (const bucket of input.buckets) {
    if (bucket.listable && !bucket.allowlisted) {
      // V3 - anonymous listing of a storage bucket that is not allowlisted.
      findings.push({
        rule: "V3",
        severity: "high",
        kind: "bucket",
        subject: bucket.name,
        message: "anonymous object listing is allowed; bucket is not allowlisted",
      });
    }
  }

  // V5 - table enumeration failed (OpenAPI off, no explicit --tables).
  if (!input.enumerated || input.maxTablesExceeded) {
    findings.push({
      rule: "V5",
      severity: "low",
      kind: "enum",
      subject: "table enumeration",
      message: input.maxTablesExceeded
        ? "more than the probe limit of tables exist; only the first 50 were probed"
        : "table enumeration failed (OpenAPI disabled and no --tables given); some tables may be unprobed",
    });
  }

  return findings;
}

/** Human label for a finding: LEAK for critical/high, REVIEW below that. */
export function findingLabel(f: Finding): string {
  return f.severity === "critical" || f.severity === "high" ? "LEAK" : "REVIEW";
}
export function verdictFromFindings(
  findings: Finding[],
  failOn: FailOn = "high",
): { verdict: Verdict; exitCode: number } {
  if (findings.length === 0) return { verdict: "CLEAN", exitCode: 0 };
  const highest = findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity]), 0);
  if (highest >= SEVERITY_RANK[failOn]) {
    return { verdict: "LEAK", exitCode: 1 };
  }
  return { verdict: "REVIEW", exitCode: 3 };
}
