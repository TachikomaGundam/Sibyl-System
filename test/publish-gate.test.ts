// publish-gate judgment locks (S1/S2 semantics from ruling fe01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type GateRun } from "../scripts/publish-gate.mjs";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HEAD = "a".repeat(40);
const hrs = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const run = (o: Partial<GateRun>): GateRun => ({ id: 1, event: "schedule", status: "completed", conclusion: "success", head_sha: HEAD, created_at: hrs(10), ...o });
const OPTS = { intervalDays: 7, capDays: 14 };

test("happy: latest scheduled run green, on HEAD, fresh", () => {
  const r = evaluate([run({})], HEAD, NOW, OPTS);
  assert.equal(r.verdict, "PASS");
});

test("no scheduled history fails (door never ran != door passed)", () => {
  assert.equal(evaluate([], HEAD, NOW, OPTS).verdict, "FAIL");
  assert.equal(evaluate([run({ event: "push" })], HEAD, NOW, OPTS).verdict, "FAIL");
});

test("latest red blocks even if an older run was green (S2 tightening)", () => {
  const r = evaluate([run({ id: 2, conclusion: "failure", created_at: hrs(20) }), run({ id: 1, created_at: hrs(100) })], HEAD, NOW, OPTS);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /conclusion=failure/);
});

test("hung latest run blocks (waiting is capped by design)", () => {
  assert.equal(evaluate([run({ status: "in_progress" })], HEAD, NOW, OPTS).verdict, "FAIL");
});

test("S1: green but bound to a different commit fails", () => {
  const r = evaluate([run({ head_sha: "b".repeat(40) })], HEAD, NOW, OPTS);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /S1/);
});

test("S2 window: >1.5x cron age fails; boundary just inside passes", () => {
  assert.equal(evaluate([run({ created_at: hrs(7 * 24 * 1.5 + 2) })], HEAD, NOW, OPTS).verdict, "FAIL");
  assert.equal(evaluate([run({ created_at: hrs(7 * 24 * 1.5 - 2) })], HEAD, NOW, OPTS).verdict, "PASS");
});

test("S2 absolute cap: widening the cron cannot widen past the cap", () => {
  // interval 60d -> 1.5x=90d, but cap 14d must bind
  const r = evaluate([run({ created_at: hrs(20 * 24) })], HEAD, NOW, { intervalDays: 60, capDays: 14 });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /cap 14d/);
});

test("future-dated run is refused (clock games fail closed)", () => {
  assert.equal(evaluate([run({ created_at: hrs(-5) })], HEAD, NOW, OPTS).verdict, "FAIL");
});
