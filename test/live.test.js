/**
 * Live smoke test (NOT run by `npm test` or CI): proves the figures cited
 * in the README are still live at the source they were quoted from.
 * Fetches a public article covering the Crissy Field research and asserts
 * it still contains the cited figures. Soft-skips on any network failure.
 */
import test from "node:test";
import assert from "node:assert/strict";

const SOURCE_URL = "https://glonce.com/lovable-apps-expose-passport-details-and-200-000/";

test("live: cited Crissy Field figures are still live at the source", async (t) => {
  let res;
  try {
    res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    t.skip(`network unavailable: ${err.message}`);
    return;
  }
  if (res.status !== 200) {
    t.skip(`source returned HTTP ${res.status}`);
    return;
  }
  const body = await res.text();
  assert.ok(body.includes("159,041"), "source no longer mentions 159,041 projects");
  assert.ok(body.includes("24,664"), "source no longer mentions 24,664 sites");
  assert.ok(body.includes("7,403"), "source no longer mentions 7,403 sites");
  assert.ok(body.includes("not a confirmed leak rate"), "source no longer carries the 30% caveat");
});
