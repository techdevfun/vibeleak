/**
 * Unit tests for vibeleak. No network: probe tests use stub fetch fns.
 * Run with: npm test (builds first, then node --test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractProjectUrl, extractSecrets } from "../dist/extract.js";
import {
  classifyJwt,
  decodeJwtPayload,
  refuseKeyReason,
  isPublishableKey,
  isSecretKey,
} from "../dist/jwt.js";
import { evaluateVerdict, verdictFromFindings, isSensitiveColumnName } from "../dist/verdict.js";
import { parseOpenApiTables, probeTable, probeProject } from "../dist/probe.js";
import { diffReports, diffFails } from "../dist/baseline.js";
import { buildReport } from "../dist/report.js";

const ANON_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc2MzExNjgwMCwiZXhwIjoxODkzNDU2MDAwfQ.c3ludGhldGljLXNpZ25hdHVyZQ";
const SERVICE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzYzMTE2ODAwLCJleHAiOjE4OTM0NTYwMDB9.c3ludGhldGljLXNpZ25hdHVyZQ";
const AUTH_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlhdCI6MTc2MzExNjgwMCwiZXhwIjoxODkzNDU2MDAwfQ.c3ludGhldGljLXNpZ25hdHVyZQ";
const PUBLISHABLE = "sb_publishable_abc123XYZ_-test";
const SECRET = "sb_secret_def456XYZ_-test";

// --- extraction -----------------------------------------------------------

test("extract: hosted Supabase URL from HTML", () => {
  const url = extractProjectUrl('<script>const u="https://abcdefghijklm.supabase.co"</script>');
  assert.equal(url, "https://abcdefghijklm.supabase.co");
});

test("extract: prefers hosted URL over localhost when both present", () => {
  const url = extractProjectUrl("http://127.0.0.1:54321 and https://abcdefghijklm.supabase.co");
  assert.equal(url, "https://abcdefghijklm.supabase.co");
});

test("extract: localhost URL from JS (self-hosted Supabase)", () => {
  assert.equal(
    extractProjectUrl('fetch("http://localhost:8000/rest/v1/")'),
    "http://localhost:8000",
  );
});

test("extract: null when no Supabase URL present", () => {
  assert.equal(extractProjectUrl("<html><body>no keys here</body></html>"), null);
});

test("extract: anon JWT found in JS, role anon", () => {
  const found = extractSecrets([`const k="${ANON_JWT}";`]);
  assert.equal(found.anonKey, ANON_JWT);
  assert.equal(found.adminSecretFound, false);
  assert.deepEqual(found.jwtRoles, ["anon"]);
});

test("extract: sb_publishable_ key found", () => {
  const found = extractSecrets([`key = "${PUBLISHABLE}"`]);
  assert.equal(found.publishableKey, PUBLISHABLE);
  assert.equal(isPublishableKey(PUBLISHABLE), true);
});

test("extract: service_role JWT in bundle is flagged", () => {
  const found = extractSecrets([`const k="${SERVICE_JWT}";`]);
  assert.equal(found.adminSecretFound, true);
  assert.equal(found.anonKey, null);
});

test("extract: sb_secret_ in bundle is flagged", () => {
  const found = extractSecrets([`const k="${SECRET}";`]);
  assert.equal(found.adminSecretFound, true);
  assert.equal(isSecretKey(SECRET), true);
});

test("extract: collects every JWT role seen", () => {
  const found = extractSecrets([`a="${ANON_JWT}"`, `b="${AUTH_JWT}"`]);
  assert.deepEqual(found.jwtRoles.sort(), ["anon", "authenticated"]);
});

// --- JWT ------------------------------------------------------------------

test("jwt: decodeJwtPayload returns the payload for an anon JWT", () => {
  const payload = decodeJwtPayload(ANON_JWT);
  assert.equal(payload?.role, "anon");
  assert.equal(payload?.iss, "supabase");
});

test("jwt: decodeJwtPayload returns null for a malformed token", () => {
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.equal(decodeJwtPayload("eyJ.bad.!!!"), null);
  assert.equal(decodeJwtPayload("a.b"), null);
});

test("jwt: classifyJwt service_role and authenticated", () => {
  assert.equal(classifyJwt(SERVICE_JWT).role, "service_role");
  assert.equal(classifyJwt(AUTH_JWT).role, "authenticated");
  assert.equal(classifyJwt("garbage").role, "unknown");
});

test("jwt: refuseKeyReason accepts anon JWT and publishable key", () => {
  assert.equal(refuseKeyReason(ANON_JWT), null);
  assert.equal(refuseKeyReason(PUBLISHABLE), null);
});

test("jwt: refuseKeyReason refuses service_role before any request", () => {
  const reason = refuseKeyReason(SERVICE_JWT);
  assert.match(reason ?? "", /service_role/);
});

test("jwt: refuseKeyReason refuses authenticated JWT", () => {
  const reason = refuseKeyReason(AUTH_JWT);
  assert.match(reason ?? "", /authenticated/);
});

test("jwt: refuseKeyReason refuses sb_secret_", () => {
  const reason = refuseKeyReason(SECRET);
  assert.match(reason ?? "", /sb_secret_/);
});

test("jwt: refuseKeyReason refuses a garbage key", () => {
  assert.notEqual(refuseKeyReason("hello-world"), null);
});

// --- verdict rules V1-V6 ---------------------------------------------------

const cleanTable = {
  name: "orders",
  rowsVisible: 0,
  columns: [],
  allowlisted: false,
};
const leakyTable = {
  name: "profiles",
  rowsVisible: 1,
  columns: ["id", "email", "passport_no"],
  allowlisted: false,
};
const publicTable = {
  name: "public_posts",
  rowsVisible: 1,
  columns: ["id", "title", "body"],
  allowlisted: true,
};

test("verdict V1: admin secret in bundle is CRITICAL and stops evaluation", () => {
  const findings = evaluateVerdict({
    adminSecretFound: true,
    tables: [leakyTable],
    buckets: [{ name: "uploads", listable: true, allowlisted: false }],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "V1");
  assert.equal(findings[0].severity, "critical");
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "LEAK",
    exitCode: 1,
  });
});

test("verdict V2: non-allowlisted table with rows is HIGH LEAK", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [leakyTable, cleanTable],
    buckets: [],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "V2");
  assert.equal(findings[0].severity, "high");
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "LEAK",
    exitCode: 1,
  });
});

test("verdict V3: non-allowlisted listable bucket is HIGH LEAK", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [cleanTable],
    buckets: [{ name: "uploads", listable: true, allowlisted: false }],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "V3");
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "LEAK",
    exitCode: 1,
  });
});

test("verdict V4: allowlisted table with a sensitive column name is MEDIUM REVIEW", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [
      {
        name: "public_posts",
        rowsVisible: 1,
        columns: ["id", "title", "api_key"],
        allowlisted: true,
      },
    ],
    buckets: [],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "V4");
  assert.equal(findings[0].severity, "medium");
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "REVIEW",
    exitCode: 3,
  });
});

test("verdict V5: failed enumeration is LOW REVIEW", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [],
    buckets: [],
    enumerated: false,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "V5");
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "REVIEW",
    exitCode: 3,
  });
});

test("verdict V6: everything clean is CLEAN exit 0", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [cleanTable, publicTable],
    buckets: [{ name: "private-files", listable: false, allowlisted: false }],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 0);
  assert.deepEqual(verdictFromFindings(findings, "high"), {
    verdict: "CLEAN",
    exitCode: 0,
  });
});

test("verdict: --fail-on medium turns a medium finding into exit 1", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [
      {
        name: "public_posts",
        rowsVisible: 1,
        columns: ["id", "token"],
        allowlisted: true,
      },
    ],
    buckets: [],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.deepEqual(verdictFromFindings(findings, "medium"), {
    verdict: "LEAK",
    exitCode: 1,
  });
});

test("verdict: sensitive column matching is case-insensitive", () => {
  assert.equal(isSensitiveColumnName("PASSPORT_NO"), true);
  assert.equal(isSensitiveColumnName("PasswordHash"), true);
  assert.equal(isSensitiveColumnName("title"), false);
  assert.equal(isSensitiveColumnName("email"), false);
});

test("verdict: allowlisted table without sensitive columns has no finding", () => {
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: [publicTable],
    buckets: [{ name: "public-assets", listable: true, allowlisted: true }],
    enumerated: true,
    maxTablesExceeded: false,
  });
  assert.equal(findings.length, 0);
});

// --- baseline diff ----------------------------------------------------------

function reportWith(tables, buckets) {
  return buildReport({
    appUrl: null,
    projectUrl: "http://127.0.0.1:1",
    verdict: "CLEAN",
    findings: [],
    tables,
    buckets,
    enumerated: true,
    notes: [],
  });
}

test("diff: table absent from baseline that leaks is a new leak", () => {
  const entries = diffReports(
    reportWith([], []),
    reportWith(
      [{ name: "profiles", rowsVisible: 1, columns: ["id"], allowlisted: false, status: "leak" }],
      [],
    ),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].change, "new-leak");
  assert.equal(diffFails(entries), true);
});

test("diff: clean table that now leaks is a regression", () => {
  const entries = diffReports(
    reportWith(
      [{ name: "profiles", rowsVisible: 0, columns: [], allowlisted: false, status: "clean" }],
      [],
    ),
    reportWith(
      [{ name: "profiles", rowsVisible: 1, columns: ["id"], allowlisted: false, status: "leak" }],
      [],
    ),
  );
  assert.equal(entries[0].change, "regression");
  assert.equal(diffFails(entries), true);
});

test("diff: leaking table that is now clean is fixed", () => {
  const entries = diffReports(
    reportWith(
      [{ name: "profiles", rowsVisible: 1, columns: ["id"], allowlisted: false, status: "leak" }],
      [],
    ),
    reportWith(
      [{ name: "profiles", rowsVisible: 0, columns: [], allowlisted: false, status: "clean" }],
      [],
    ),
  );
  assert.equal(entries[0].change, "fixed");
  assert.equal(diffFails(entries), false);
});

test("diff: unchanged tables and buckets do not fail", () => {
  const entries = diffReports(
    reportWith(
      [{ name: "orders", rowsVisible: 0, columns: [], allowlisted: false, status: "clean" }],
      [{ name: "private-files", listable: false, allowlisted: false, status: "clean" }],
    ),
    reportWith(
      [{ name: "orders", rowsVisible: 0, columns: [], allowlisted: false, status: "clean" }],
      [{ name: "private-files", listable: false, allowlisted: false, status: "clean" }],
    ),
  );
  assert.equal(entries.length, 2);
  assert.equal(diffFails(entries), false);
});

// --- OpenAPI parsing ---------------------------------------------------------

test("openapi: parses table paths, skips rpc", () => {
  const tables = parseOpenApiTables(
    JSON.stringify({
      paths: {
        "/profiles": {},
        "/orders": {},
        "/rpc/get_stats": {},
        "/": {},
      },
    }),
  );
  assert.deepEqual(tables, ["orders", "profiles"]);
});

test("openapi: malformed JSON returns no tables", () => {
  assert.deepEqual(parseOpenApiTables("not json"), []);
  assert.deepEqual(parseOpenApiTables(JSON.stringify({ paths: null })), []);
});

// --- probe behaviour (stub fetch) ---------------------------------------------

function stubFetchFactory(routes) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" });
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return { status: 404, text: "{}", headers: new Headers() };
    return { status: hit.status, text: JSON.stringify(hit.body), headers: new Headers() };
  };
  fn.calls = calls;
  return fn;
}

test("probe: probeTable issues HEAD then GET with limit=1, GET/HEAD only", async () => {
  const fetchFn = stubFetchFactory([
    { match: "/rest/v1/profiles", status: 200, body: [{ id: 1, email: "a@b.invalid" }] },
  ]);
  const result = await probeTable("http://127.0.0.1:9", "profiles", ANON_JWT, fetchFn);
  assert.equal(result.rowsVisible, 1);
  assert.deepEqual(result.columns, ["id", "email"]);
  const methods = fetchFn.calls.map((c) => c.method);
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.ok(fetchFn.calls.every((c) => c.url.includes("limit=1")));
});

test("probe: probeTable returns 0 rows on 403 (RLS blocks)", async () => {
  const fetchFn = stubFetchFactory([
    { match: "/rest/v1/orders", status: 403, body: { message: "Forbidden" } },
  ]);
  const result = await probeTable("http://127.0.0.1:9", "orders", ANON_JWT, fetchFn);
  assert.equal(result.rowsVisible, 0);
  assert.deepEqual(result.columns, []);
});

test("probe: report never contains row values, only column names", async () => {
  const fetchFn = stubFetchFactory([
    {
      match: "/rest/v1/profiles",
      status: 200,
      body: [{ id: 1, email: "ada@example.invalid", passport_no: "SYNTHETIC-0001" }],
    },
  ]);
  const probe = await probeTable("http://127.0.0.1:9", "profiles", ANON_JWT, fetchFn);
  const json = JSON.stringify(probe);
  assert.ok(!json.includes("ada@example.invalid"), "row value leaked into probe result");
  assert.ok(!json.includes("SYNTHETIC-0001"), "row value leaked into probe result");
  assert.ok(json.includes("passport_no"), "column name must be recorded");
});

test("probe: maxTables cap probes only the first 50 and flags REVIEW", async () => {
  const tables = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const fetchFn = async (url) => {
    if (url.endsWith("/rest/v1/")) {
      return {
        status: 200,
        text: JSON.stringify({ paths: Object.fromEntries(tables.map((t) => [`/${t}`, {}])) }),
        headers: new Headers(),
      };
    }
    if (url.includes("/storage/v1/bucket")) {
      return { status: 200, text: "[]", headers: new Headers() };
    }
    return { status: 200, text: "[]", headers: new Headers() };
  };
  const outcome = await probeProject({
    projectUrl: "http://127.0.0.1:9",
    anonKey: ANON_JWT,
    config: {
      version: 1,
      publicTables: [],
      publicBuckets: [],
      failOn: "high",
      maxTables: 50,
    },
    fetchFn,
  });
  assert.equal(outcome.tables.length, 50);
  assert.equal(outcome.maxTablesExceeded, true);
  const findings = evaluateVerdict({
    adminSecretFound: false,
    tables: outcome.tables,
    buckets: outcome.buckets,
    enumerated: outcome.enumerated,
    maxTablesExceeded: outcome.maxTablesExceeded,
  });
  assert.ok(findings.some((f) => f.rule === "V5"));
});
