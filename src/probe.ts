/**
 * The probe engine: enumerate tables via the PostgREST OpenAPI document,
 * then prove what an anonymous visitor can read with one HEAD + one
 * GET (?select=*&limit=1) per table. Only column names and a 0/1
 * rows-visible flag are ever recorded - never row values.
 */
import { fetchWithTimeout } from "./http.js";
import { probeStorage } from "./storage.js";
import type { BucketReport, TableReport, VibeleakConfig } from "./report.js";

export interface ProbeOptions {
  projectUrl: string;
  anonKey: string;
  /** Explicit table list (skips OpenAPI enumeration when given). */
  tables?: string[];
  config: VibeleakConfig;
  fetchFn?: typeof fetchWithTimeout;
}

export interface ProbeOutcome {
  tables: TableReport[];
  buckets: BucketReport[];
  enumerated: boolean;
  maxTablesExceeded: boolean;
  notes: string[];
}

function anonHeaders(anonKey: string): Record<string, string> {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

/**
 * Parse a PostgREST OpenAPI document into table names.
 * Paths look like "/profiles"; /rpc/* and other non-table paths are skipped.
 */
export function parseOpenApiTables(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const paths = (parsed as Record<string, unknown>).paths;
  if (paths === null || typeof paths !== "object") return [];
  const tables: string[] = [];
  for (const key of Object.keys(paths as Record<string, unknown>)) {
    if (!key.startsWith("/")) continue;
    const name = key.slice(1);
    if (name.length === 0) continue;
    if (name.includes("/")) continue;
    if (name.startsWith("rpc")) continue;
    tables.push(name);
  }
  return tables.sort();
}

async function enumerateTables(
  projectUrl: string,
  anonKey: string,
  fetchFn: typeof fetchWithTimeout,
): Promise<string[] | null> {
  const url = `${projectUrl.replace(/\/$/, "")}/rest/v1/`;
  let res;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { ...anonHeaders(anonKey), Accept: "application/openapi+json" },
    });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  const tables = parseOpenApiTables(res.text);
  return tables.length > 0 ? tables : null;
}

export interface TableProbe {
  name: string;
  rowsVisible: number;
  columns: string[];
}

/** One HEAD + one GET per table. Returns rowsVisible 0/1 + column names. */
export async function probeTable(
  projectUrl: string,
  table: string,
  anonKey: string,
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<TableProbe> {
  const base = `${projectUrl.replace(/\/$/, "")}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;
  try {
    await fetchFn(base, { method: "HEAD", headers: anonHeaders(anonKey) });
  } catch {
    // A failed HEAD is not fatal: the GET below is the real probe.
  }
  let res;
  try {
    res = await fetchFn(base, { method: "GET", headers: anonHeaders(anonKey) });
  } catch {
    return { name: table, rowsVisible: 0, columns: [] };
  }
  if (res.status !== 200) return { name: table, rowsVisible: 0, columns: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { name: table, rowsVisible: 0, columns: [] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { name: table, rowsVisible: 0, columns: [] };
  }
  const first = parsed[0];
  const columns =
    first !== null && typeof first === "object"
      ? Object.keys(first as Record<string, unknown>).slice(0, 20)
      : [];
  return { name: table, rowsVisible: 1, columns };
}

export async function probeProject(opts: ProbeOptions): Promise<ProbeOutcome> {
  const fetchFn = opts.fetchFn ?? fetchWithTimeout;
  const notes: string[] = [];
  const maxTables = opts.config.maxTables;

  let tableNames: string[] = [];
  let enumerated = true;
  if (opts.tables && opts.tables.length > 0) {
    tableNames = opts.tables;
  } else {
    const found = await enumerateTables(opts.projectUrl, opts.anonKey, fetchFn);
    if (found === null) {
      enumerated = false;
      notes.push(
        "table enumeration failed: OpenAPI document is disabled; re-run with --tables to probe explicit tables",
      );
    } else {
      tableNames = found;
    }
  }

  let maxTablesExceeded = false;
  if (tableNames.length > maxTables) {
    maxTablesExceeded = true;
    notes.push(
      `found ${tableNames.length} tables; probing only the first ${maxTables} (maxTables limit)`,
    );
    tableNames = tableNames.slice(0, maxTables);
  }

  const allowTables = new Set(opts.config.publicTables);
  const tables: TableReport[] = [];
  for (const name of tableNames) {
    const probe = await probeTable(opts.projectUrl, name, opts.anonKey, fetchFn);
    const allowlisted = allowTables.has(name);
    const status = probe.rowsVisible >= 1 ? (allowlisted ? "allowlisted" : "leak") : "clean";
    tables.push({
      name,
      rowsVisible: probe.rowsVisible,
      columns: probe.columns,
      allowlisted,
      status,
    });
  }

  const allowBuckets = new Set(opts.config.publicBuckets);
  const bucketProbes = await probeStorage(opts.projectUrl, opts.anonKey, fetchFn);
  const buckets: BucketReport[] = bucketProbes.map((b) => {
    const allowlisted = allowBuckets.has(b.name);
    return {
      name: b.name,
      listable: b.listable,
      allowlisted,
      status: b.listable ? (allowlisted ? "allowlisted" : "leak") : "clean",
    };
  });

  return { tables, buckets, enumerated, maxTablesExceeded, notes };
}
