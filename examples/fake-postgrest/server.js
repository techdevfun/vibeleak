#!/usr/bin/env node
/**
 * Fake PostgREST + fake app server for vibeleak tests and demo.
 * Local only: binds 127.0.0.1, random port when PORT=0.
 *
 * Environment:
 *   PORT          port to listen on (0 = random, prints the real port)
 *   FAKE_MODE     "leaky" (default) or "fixed"
 *                   leaky: profiles returns 1 synthetic row, uploads bucket lists
 *                   fixed: profiles returns [], uploads bucket is private
 *   FAKE_OPENAPI  "on" (default) or "off" (OpenAPI document disabled)
 *   FAKE_APP_DIR  directory with index.html + app.js (default ../fake-app)
 *
 * Every request is appended to requests.log in the current directory so
 * tests can assert which endpoints a run actually hit.
 *
 * ALL data is SYNTHETIC, labelled as such, and never leaves this machine.
 */
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? "0");
const MODE = process.env.FAKE_MODE === "fixed" ? "fixed" : "leaky";
const OPENAPI = process.env.FAKE_OPENAPI === "off" ? "off" : "on";
const APP_DIR = process.env.FAKE_APP_DIR ?? join(HERE, "..", "fake-app");

const SYNTHETIC_ROW = {
  id: 1,
  email: "ada@example.invalid",
  passport_no: "SYNTHETIC-0001",
};
const PUBLIC_POST_ROW = {
  id: 1,
  title: "Hello (synthetic)",
  body: "Synthetic example post.",
};

function logRequest(method, path) {
  try {
    appendFileSync("requests.log", `${method} ${path}\n`, "utf8");
  } catch {
    // Logging must never break the fixture server.
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  logRequest(req.method, path);

  // HEAD: headers only, no body (PostgREST answers HEAD the same way).
  if (req.method === "HEAD") {
    if (path.startsWith("/rest/v1/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/") {
    sendText(res, 200, readFileSync(join(APP_DIR, "index.html"), "utf8"), "text/html");
    return;
  }

  if (req.method === "GET" && path === "/app.js") {
    const port = server.address().port;
    const raw = readFileSync(join(APP_DIR, "app.js"), "utf8");
    const filled = raw.replaceAll(
      "__SUPABASE_URL__",
      `http://127.0.0.1:${port}`,
    );
    sendText(res, 200, filled, "text/javascript");
    return;
  }

  if (req.method === "GET" && path === "/rest/v1/") {
    if (OPENAPI === "off") {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    sendJson(res, 200, {
      openapi: "3.0.0",
      paths: {
        "/profiles": { get: {} },
        "/orders": { get: {} },
        "/public_posts": { get: {} },
      },
    });
    return;
  }

  if (req.method === "GET" && path === "/rest/v1/profiles") {
    sendJson(res, 200, MODE === "leaky" ? [SYNTHETIC_ROW] : []);
    return;
  }
  if (req.method === "GET" && path === "/rest/v1/orders") {
    sendJson(res, 200, []);
    return;
  }
  if (req.method === "GET" && path === "/rest/v1/public_posts") {
    sendJson(res, 200, [PUBLIC_POST_ROW]);
    return;
  }

  if (req.method === "GET" && path === "/storage/v1/bucket") {
    sendJson(res, 200, [
      { id: "uploads", name: "uploads" },
      { id: "public-assets", name: "public-assets" },
      { id: "private-files", name: "private-files" },
    ]);
    return;
  }

  const listMatch = path.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
  if (req.method === "GET" && listMatch) {
    const bucket = decodeURIComponent(listMatch[1]);
    if (bucket === "public-assets") {
      sendJson(res, 200, [{ name: "logo.svg" }]);
      return;
    }
    if (bucket === "uploads" && MODE === "leaky") {
      sendJson(res, 200, [{ name: "synthetic-file.txt" }]);
      return;
    }
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  sendJson(res, 404, { message: "Not Found" });
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`fake-postgrest listening on http://127.0.0.1:${port} (mode=${MODE}, openapi=${OPENAPI})`);
});
