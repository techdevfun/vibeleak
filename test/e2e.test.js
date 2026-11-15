/**
 * E2E tests: the real CLI against the local fake PostgREST fixture server.
 * The server binds 127.0.0.1 only and serves synthetic data; nothing here
 * touches a real Supabase project or a real app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "dist", "cli.js");
const SERVER = join(ROOT, "examples", "fake-postgrest", "server.js");
const EXAMPLE_CONFIG = join(ROOT, "examples", "vibeleak.json");

const ANON_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc2MzExNjgwMCwiZXhwIjoxODkzNDU2MDAwfQ.c3ludGhldGljLXNpZ25hdHVyZQ";
const SERVICE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzYzMTE2ODAwLCJleHAiOjE4OTM0NTYwMDB9.c3ludGhldGljLXNpZ25hdHVyZQ";

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), "vibeleak-e2e-"));
  copyFileSync(EXAMPLE_CONFIG, join(dir, "vibeleak.json"));
  return dir;
}

function startServer(env = {}) {
  const dir = workDir();
  const proc = spawn("node", [SERVER], {
    cwd: dir,
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10000);
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${out}`));
    });
  });
  return ready.then((port) => ({ proc, port, dir, baseUrl: `http://127.0.0.1:${port}` }));
}

function stopServer(server) {
  server.proc.kill("SIGTERM");
}

function runCli(args, cwd) {
  const res = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", timeout: 30000 });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function requestsLog(dir) {
  const path = join(dir, "requests.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("e2e: scan on the leaky fixture exits 1 with the right report", async () => {
  const server = await startServer({ FAKE_MODE: "leaky" });
  try {
    const out = join(server.dir, "report.json");
    const res = runCli(["scan", server.baseUrl, "--i-own-this-app", "--out", out], server.dir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /LEAK: profiles/);
    assert.match(res.stdout, /columns: id, email, passport_no/);
    assert.match(res.stdout, /verdict: LEAK/);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.verdict, "LEAK");
    const profiles = report.tables.find((t) => t.name === "profiles");
    assert.equal(profiles.status, "leak");
    assert.deepEqual(profiles.columns, ["id", "email", "passport_no"]);
    const orders = report.tables.find((t) => t.name === "orders");
    assert.equal(orders.status, "clean");
    const posts = report.tables.find((t) => t.name === "public_posts");
    assert.equal(posts.status, "allowlisted");
    const uploads = report.buckets.find((b) => b.name === "uploads");
    assert.equal(uploads.status, "leak");
    const json = readFileSync(out, "utf8");
    assert.ok(!json.includes("ada@example.invalid"), "row value in report");
    assert.ok(!json.includes("SYNTHETIC-0001"), "row value in report");
  } finally {
    stopServer(server);
  }
});

test("e2e: probe with explicit --tables exits 1 on the leaky fixture", async () => {
  const server = await startServer({ FAKE_MODE: "leaky" });
  try {
    const res = runCli(
      [
        "probe",
        "--url",
        server.baseUrl,
        "--anon-key",
        ANON_JWT,
        "--tables",
        "profiles",
        "orders",
        "--i-own-this-app",
      ],
      server.dir,
    );
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /LEAK: profiles/);
  } finally {
    stopServer(server);
  }
});

test("e2e: check with a leaky baseline and leaky report exits 1", async () => {
  const server = await startServer({ FAKE_MODE: "leaky" });
  try {
    const reportPath = join(server.dir, "report.json");
    const scan = runCli(
      ["scan", server.baseUrl, "--i-own-this-app", "--out", reportPath],
      server.dir,
    );
    assert.equal(scan.status, 1);
    const res = runCli(["check", "--report", reportPath, "--baseline", reportPath], server.dir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /verdict: LEAK/);
  } finally {
    stopServer(server);
  }
});

test("e2e: after the fix, scan is CLEAN and check exits 0", async () => {
  const leaky = await startServer({ FAKE_MODE: "leaky" });
  let beforePath;
  try {
    beforePath = join(leaky.dir, "before.json");
    const scan = runCli(
      ["scan", leaky.baseUrl, "--i-own-this-app", "--out", beforePath],
      leaky.dir,
    );
    assert.equal(scan.status, 1);
  } finally {
    stopServer(leaky);
  }
  const fixed = await startServer({ FAKE_MODE: "fixed" });
  try {
    const afterPath = join(fixed.dir, "after.json");
    const scan = runCli(["scan", fixed.baseUrl, "--i-own-this-app", "--out", afterPath], fixed.dir);
    assert.equal(scan.status, 0, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /verdict: CLEAN/);
    const check = runCli(["check", "--report", afterPath, "--baseline", beforePath], fixed.dir);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /public_posts still public by design \(allowlisted\)/);
    assert.match(check.stdout, /no regressions vs baseline/);
  } finally {
    stopServer(fixed);
  }
});

test("e2e: diff after the fix shows profiles LEAK -> CLEAN (fixed)", async () => {
  const leaky = await startServer({ FAKE_MODE: "leaky" });
  let beforePath;
  try {
    beforePath = join(leaky.dir, "before.json");
    const scan = runCli(
      ["scan", leaky.baseUrl, "--i-own-this-app", "--out", beforePath],
      leaky.dir,
    );
    assert.equal(scan.status, 1);
  } finally {
    stopServer(leaky);
  }
  const fixed = await startServer({ FAKE_MODE: "fixed" });
  try {
    const afterPath = join(fixed.dir, "after.json");
    const scan = runCli(["scan", fixed.baseUrl, "--i-own-this-app", "--out", afterPath], fixed.dir);
    assert.equal(scan.status, 0);
    const diff = runCli(["diff", "--baseline", beforePath, "--report", afterPath], fixed.dir);
    assert.equal(diff.status, 0, diff.stdout + diff.stderr);
    assert.match(diff.stdout, /profiles: LEAK -> CLEAN \(fixed\)/);
    assert.match(diff.stdout, /uploads: LEAK -> CLEAN \(fixed\)/);
    assert.match(diff.stdout, /2 fixed, 0 new leaks, 0 regressions/);
  } finally {
    stopServer(fixed);
  }
});

test("e2e: diff flags a regression when a closed table opens again", async () => {
  const fixed = await startServer({ FAKE_MODE: "fixed" });
  let fixedPath;
  try {
    fixedPath = join(fixed.dir, "fixed.json");
    const scan = runCli(["scan", fixed.baseUrl, "--i-own-this-app", "--out", fixedPath], fixed.dir);
    assert.equal(scan.status, 0);
  } finally {
    stopServer(fixed);
  }
  const leaky = await startServer({ FAKE_MODE: "leaky" });
  try {
    const leakyPath = join(leaky.dir, "leaky.json");
    const scan = runCli(["scan", leaky.baseUrl, "--i-own-this-app", "--out", leakyPath], leaky.dir);
    assert.equal(scan.status, 1);
    const diff = runCli(["diff", "--baseline", fixedPath, "--report", leakyPath], leaky.dir);
    assert.equal(diff.status, 1, diff.stdout + diff.stderr);
    assert.match(diff.stdout, /profiles: CLEAN -> LEAK \(regression\)/);
  } finally {
    stopServer(leaky);
  }
});

test("e2e: init creates vibeleak.json and vibeleak.baseline.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeleak-init-"));
  const first = runCli(["init", "--dir", dir], dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(join(dir, "vibeleak.json")));
  assert.ok(existsSync(join(dir, "vibeleak.baseline.json")));
  const config = JSON.parse(readFileSync(join(dir, "vibeleak.json"), "utf8"));
  assert.deepEqual(config.publicTables, ["public_posts"]);
  const second = runCli(["init", "--dir", dir], dir);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already exists, left unchanged/);
});

test("e2e: scan without consent exits 2 and sends no request", async () => {
  const server = await startServer({ FAKE_MODE: "leaky" });
  try {
    const res = runCli(["scan", server.baseUrl], server.dir);
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /consent required/);
    assert.ok(!requestsLog(server.dir).includes("/rest/v1/"), "requests were sent without consent");
  } finally {
    stopServer(server);
  }
});

test("e2e: service_role key is refused before any request", async () => {
  const server = await startServer({ FAKE_MODE: "leaky" });
  try {
    const res = runCli(
      ["probe", "--url", server.baseUrl, "--anon-key", SERVICE_JWT, "--i-own-this-app"],
      server.dir,
    );
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /service_role/);
    assert.ok(
      !requestsLog(server.dir).includes("/rest/v1/"),
      "probe requests were sent with a service_role key",
    );
  } finally {
    stopServer(server);
  }
});

test("e2e: OpenAPI off still probes buckets; fixed mode gives REVIEW exit 3", async () => {
  const leaky = await startServer({ FAKE_MODE: "leaky", FAKE_OPENAPI: "off" });
  try {
    // Tables cannot be enumerated, but the leaking bucket is still caught.
    const scan = runCli(["scan", leaky.baseUrl, "--i-own-this-app"], leaky.dir);
    assert.equal(scan.status, 1, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /table enumeration failed/);
    assert.match(scan.stdout, /LEAK: uploads/);
    const probe = runCli(
      [
        "probe",
        "--url",
        leaky.baseUrl,
        "--anon-key",
        ANON_JWT,
        "--tables",
        "profiles",
        "--i-own-this-app",
      ],
      leaky.dir,
    );
    assert.equal(probe.status, 1, probe.stdout + probe.stderr);
    assert.match(probe.stdout, /LEAK: profiles/);
  } finally {
    stopServer(leaky);
  }
  // With the fixture fixed, OpenAPI off leaves only the V5 REVIEW finding.
  const fixed = await startServer({ FAKE_MODE: "fixed", FAKE_OPENAPI: "off" });
  try {
    const scan = runCli(["scan", fixed.baseUrl, "--i-own-this-app"], fixed.dir);
    assert.equal(scan.status, 3, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /verdict: REVIEW/);
    assert.match(scan.stdout, /REVIEW: table enumeration/);
  } finally {
    stopServer(fixed);
  }
});

test("e2e: --help and --version work", async () => {
  const dir = workDir();
  const help = runCli(["--help"], dir);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vibeleak scan/);
  assert.match(help.stdout, /--i-own-this-app/);
  const version = runCli(["--version"], dir);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /vibeleak 0\.1\.0/);
});
