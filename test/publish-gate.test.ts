// publish-gate judgment locks (S1/S2 semantics from ruling fe01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, DEFAULTS, DEFAULT_WORKFLOW, type GateRun } from "../scripts/publish-gate.mjs";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HEAD = "a".repeat(40);
const hrs = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const run = (o: Partial<GateRun>): GateRun => ({ id: 1, event: "schedule", status: "completed", conclusion: "success", head_sha: HEAD, head_branch: "main", created_at: hrs(10), ...o });
// H1 cadence defaults are locked to the measured wall time of scheduled-audit
// (must-fix 6): 2026-11-09 gh api run history — the last 9 completed runs took
// 12s..35s created_at->updated_at INCLUDING queue time; the 20-minute bound
// sits >34x above the observed worst case (cold-cache npm ci+audit slack
// covered many times over), and a 30s poll keeps even the full bound at ~40
// API calls per release.
const OPTS = { intervalDays: 7, capDays: 14, pollSeconds: 30, waitMinutes: 20 };

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

test("repo-owned dispatch witness counts; foreign events (push/pull_request) never do", () => {
  assert.equal(evaluate([run({ event: "workflow_dispatch" })], HEAD, NOW, OPTS).verdict, "PASS");
  assert.equal(evaluate([run({ event: "push" })], HEAD, NOW, OPTS).verdict, "FAIL");
  assert.equal(evaluate([run({ event: "pull_request", conclusion: "success" })], HEAD, NOW, OPTS).verdict, "FAIL");
});

test("6935 forgery locks: off-branch witnesses never count; their very existence with a green result refuses", () => {
  assert.equal(evaluate([run({ head_branch: "evil-branch" })], HEAD, NOW, OPTS).verdict, "FAIL");
  assert.equal(evaluate([run({ head_branch: "main" }), run({ id: 9, head_branch: "evil", conclusion: "success" })], HEAD, NOW, OPTS).verdict, "FAIL");
});

test("2b4a follow-up: tripwire is SOME across the window — poison buried behind failed probes still refuses", () => {
  const ok = run({ id: 100 }); // fresh green main witness at the head
  const deadProbe = run({ id: 101, head_branch: "evil-a", conclusion: "failure", created_at: hrs(1) });
  const buriedPoison = run({ id: 102, head_branch: "evil-b", conclusion: "success", created_at: hrs(2) });
  assert.equal(evaluate([ok, deadProbe, buriedPoison], HEAD, NOW, OPTS).verdict, "FAIL");
  const stillRunning = run({ id: 103, head_branch: "evil-c", status: "in_progress", conclusion: null, created_at: hrs(2) });
  assert.equal(evaluate([ok, deadProbe, stillRunning], HEAD, NOW, OPTS).verdict, "FAIL");
  // completed-and-failed foreign probes alone are tolerated (they prove nothing)
  assert.equal(evaluate([ok, deadProbe, run({ id: 104, head_branch: "evil-d", conclusion: "failure", created_at: hrs(3) })], HEAD, NOW, OPTS).verdict, "PASS");
});

test("6935 clamp: caller args can never widen past the 14d ceiling", () => {
  assert.equal(evaluate([run({ created_at: hrs(15 * 24) })], HEAD, NOW, { intervalDays: 60, capDays: 9999 }).verdict, "FAIL");
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

// 88e5 lock: malformed args fail closed instead of NaN-widening the window
import { spawnSync } from "node:child_process";
test("88e5: garbage --cap-days cannot NaN-widen the door (fail-closed)", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/publish-gate.mjs", "--cap-days=14x"], {
    encoding: "utf8", cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, GH_REPO: "x/y", GH_TOKEN: "t", HEAD_SHA: "h" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a positive finite number/);
});

test("co-change lock (98f3 gate finding A): operative defaults cannot drift from the locked judgment table", () => {
  assert.deepStrictEqual(DEFAULTS, OPTS);
  assert.equal(DEFAULT_WORKFLOW, "scheduled-audit.yml");
});

// --- H1 release-day auto-witness (council-2-alt 2026-11-08, six binding must-fixes) ---

const TAG = "v9.9.9";
const TAG_B = "v9.9.8";
const TAG_CREATED = NOW - 600_000; // the tag ref existed 10min before "now"
const DEADLINE = NOW + 20 * 60_000; // the wait bound has not passed at NOW
const RD = { ...OPTS, tagRef: TAG, tagRefCreatedAtMs: TAG_CREATED, deadlineMs: DEADLINE };
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const tagRun = (o: Partial<GateRun>): GateRun => run({ id: 200, event: "push", head_branch: TAG, created_at: at(300_000), ...o });

test("H1 happy: the push witness the tag itself triggered, green on HEAD -> PASS", () => {
  const r = evaluate([tagRun({})], HEAD, NOW, RD);
  assert.equal(r.verdict, "PASS");
  assert.match(r.why, /push\/v9.9.9/);
});

test("H1 lock green-on-wrong-sha: latest green elsewhere is never the witness — WAIT, then timeout FAIL", () => {
  const staleGreen = run({ id: 5, created_at: at(3_600_000), head_sha: "c".repeat(40) }); // schedule, main, wrong sha, post-tag
  const r = evaluate([staleGreen], HEAD, NOW, RD);
  assert.equal(r.verdict, "WAIT");
  const timed = evaluate([staleGreen], HEAD, DEADLINE + 1, RD);
  assert.equal(timed.verdict, "FAIL");
  assert.match(timed.why, /PUBLISH BLOCKED/);
});

test("H1 lock audit-in-progress: WAIT while the tag audit runs; overdue it is a loud refusal, not silence", () => {
  const r = evaluate([tagRun({ status: "in_progress", conclusion: null })], HEAD, NOW, RD);
  assert.equal(r.verdict, "WAIT");
  assert.match(r.why, /polling every 30s/);
  const timed = evaluate([tagRun({ status: "in_progress", conclusion: null })], HEAD, DEADLINE + 1, RD);
  assert.equal(timed.verdict, "FAIL");
  assert.match(timed.why, /never left in_progress/);
});

test("H1 lock timeout: no tied witness ever appears -> WAIT then FAIL with owner-named next step", () => {
  const r = evaluate([], HEAD, NOW, RD);
  assert.equal(r.verdict, "WAIT");
  const timed = evaluate([], HEAD, DEADLINE + 1, RD);
  assert.equal(timed.verdict, "FAIL");
  assert.match(timed.why, /no tag-tied audit run appeared/);
  assert.match(timed.why, /inspect this repo's Actions runs for v9\.9\.9/);
});

test("H1 lock two-tags-one-window: the vA witness never satisfies a vB publish, same sha included", () => {
  const wA = tagRun({ id: 300 }); // green push witness for TAG, on HEAD
  assert.equal(evaluate([wA], HEAD, NOW, { ...RD, tagRef: TAG }).verdict, "PASS");
  const r = evaluate([wA], HEAD, NOW, { ...RD, tagRef: TAG_B }); // vB publish, same commit
  assert.equal(r.verdict, "WAIT");
  assert.equal(evaluate([wA], HEAD, DEADLINE + 1, { ...RD, tagRef: TAG_B }).verdict, "FAIL");
});

test("H1 causal tie: a stale same-sha green from BEFORE the tag never counts; a default-branch run created after it does", () => {
  const preTag = run({ id: 7, created_at: new Date(TAG_CREATED - 60_000).toISOString() }); // main, HEAD sha, pre-tag
  assert.equal(evaluate([preTag], HEAD, NOW, RD).verdict, "WAIT");
  const postTag = run({ id: 8, created_at: new Date(TAG_CREATED + 60_000).toISOString() }); // dispatched after the tag existed
  assert.equal(evaluate([postTag], HEAD, NOW, RD).verdict, "PASS");
});

test("H1: a red tied witness fails immediately — a red audit is answered by fixing, not by waiting", () => {
  const r = evaluate([tagRun({ conclusion: "failure" })], HEAD, NOW, RD);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /PUBLISH BLOCKED/);
});

test("H1 forgery: a lookalike BRANCH named like the tag is not the tag — push witnesses must match the exact tag ref", () => {
  const lookalike = run({ id: 9, event: "push", head_branch: "v9.9.9-evil", created_at: at(300_000) });
  assert.equal(evaluate([lookalike], HEAD, NOW, RD).verdict, "WAIT");
  assert.equal(evaluate([lookalike], HEAD, DEADLINE + 1, RD).verdict, "FAIL");
});

test("H1: the 2b4a foreign-dispatch poison tripwire guards the release-day door too", () => {
  const r = evaluate([tagRun({}), run({ id: 11, head_branch: "evil", conclusion: "success" })], HEAD, NOW, RD);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /forgery posture/);
});

test("H1: future-dated tied witness refused (clock games fail closed on the waiting door too)", () => {
  const r = evaluate([tagRun({ created_at: new Date(NOW + 600_000).toISOString() })], HEAD, NOW, RD);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.why, /stale green|refusing/i);
});

test("H1: one-shot mode (no tagRef) never returns WAIT — legacy judgment table intact", () => {
  const hung = evaluate([run({ status: "in_progress", conclusion: null })], HEAD, NOW, OPTS);
  assert.equal(hung.verdict, "FAIL");
  const good = evaluate([run({})], HEAD, NOW, OPTS);
  assert.equal(good.verdict, "PASS");
});

test("H1 refusal: TAG_REF without a parseable TAG_REF_CREATED_AT refuses before any network (fail-closed)", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/publish-gate.mjs"], {
    encoding: "utf8", cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, GH_REPO: "x/y", GH_TOKEN: "t", HEAD_SHA: "h", TAG_REF: "v9.9.9", TAG_REF_CREATED_AT: "" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no causal tie, no publish/);
});
