// session-reap classifier locks: narrow scope (only sibyl:-minted titles),
// audit roots protected without owner ruling, tier-A grace, open-run guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, openRunSessionIds } from "../scripts/session-reap.mjs";

const NOW = Date.UTC(2026, 10, 2);
const d = (n) => NOW - n * 86_400_000;
const s = (id, title, parentID, updated) => ({ id, title, parentID, updated });

test("out-of-scope titles never listed at all", () => {
  const acts = classify([s("x", "General chat", null, d(999)), s("y", "Sibyl-System notes", "p", d(99))], { nowMs: NOW, tierADays: 7 });
  assert.equal(acts.length, 0);
});

test("'Sibyl' word-prefix children are out of scope (only sibyl: grammar is ours)", () => {
  const acts = classify([s("a", "Sibyl review discussion", "p", d(90))], { nowMs: NOW, tierADays: 7 });
  assert.equal(acts.length, 0);
});

test("tier-A: parented sibyl:persona children past grace delete; inside grace keep", () => {
  const acts = classify([
    s("old", "sibyl:persona MELCHIOR", "p", d(30)),
    s("fresh", "sibyl:persona CASPER", "p", d(2)),
  ], { nowMs: NOW, tierADays: 7 });
  const m = Object.fromEntries(acts.map((a) => [a.id, a.action]));
  assert.equal(m.old, "delete");
  assert.equal(m.fresh, "keep");
});

test("audit roots: keep without owner ruling; delete only with ruling AND past tier-B age", () => {
  const one = [s("aud", "sibyl:audit convener", null, d(200))];
  assert.equal(classify(one, { nowMs: NOW, tierADays: 7 })[0].action, "keep");
  assert.equal(classify(one, { nowMs: NOW, tierADays: 7, tierBDays: 90 })[0].action, "keep", "tier-B age without ruling must not delete");
  assert.equal(classify(one, { nowMs: NOW, tierADays: 7, tierBDays: 90, ownerRuling: true })[0].action, "delete");
  assert.equal(classify([s("aud2", "sibyl:audit convener", null, d(10))], { nowMs: NOW, tierADays: 7, tierBDays: 90, ownerRuling: true })[0].action, "keep", "young audit root stays even with ruling");
});

test("open-run protection beats age", () => {
  const acts = classify([s("busy", "sibyl:persona MELCHIOR", "p", d(99))], { nowMs: NOW, tierADays: 7, protectedIds: new Set(["busy"]) });
  assert.equal(acts[0].action, "keep");
  assert.match(acts[0].reason, /not terminal/);
});

test("openRunSessionIds: only non-terminal runs contribute ids", () => {
  const ids = openRunSessionIds({ runs: [
    { status: "done", sessionIDs: ["d1"] },
    { status: "running", sessionIDs: ["r1"], auditorSessionID: "a1" },
    { status: "sealed", sessionIDs: ["s1"] },
  ] });
  assert.deepEqual([...ids].sort(), ["a1", "r1"]);
});

test("--keep override protects a matching id from tier-A delete", () => {
  const acts = classify([s("keepme", "sibyl:persona MELCHIOR", "p", d(99))], { nowMs: NOW, tierADays: 7, keepRe: /^keepme$/ });
  assert.equal(acts[0].action, "keep");
});
