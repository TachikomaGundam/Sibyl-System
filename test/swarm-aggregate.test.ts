// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// AGGREGATE stage unit tests: context-sharding fan-in (summarizeTaskOutput —
// full drafts never travel downstream), the derived verdict vocabulary
// (APPROVE | REJECT | EXHAUSTED single source of truth) and the OPTIONAL
// judge callback (judge criteria wiring; invalid judge output fails closed
// to the derived verdict).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReport, summarizeTaskOutput } from "../src/swarm/aggregate.ts";
import { SWARM_VERDICTS } from "../src/swarm/types.ts";
import type { JudgeFn, ReportInput } from "../src/swarm/aggregate.ts";

const DONE_TASKS: ReportInput["tasks"] = [
  { id: "t1", status: "done", summary: "s1" },
  { id: "t2", status: "done", sessionId: "sess-2", summary: "s2" },
];
const ARTIFACTS = ["space/t1.md", "space/t2.md"];

const baseInput = (over: Partial<ReportInput> = {}): ReportInput => ({
  rounds: 2,
  exhausted: false,
  tasks: DONE_TASKS.map((t) => ({ ...t })),
  artifacts: [...ARTIFACTS],
  ...over,
});

test("summarizeTaskOutput: short text passes through untouched, long text is deterministically truncated", () => {
  assert.equal(summarizeTaskOutput("short", 10), "short");
  const long = "x".repeat(100_000);
  const summary = summarizeTaskOutput(long, 50);
  assert.ok(summary.startsWith("x".repeat(50)));
  assert.ok(summary.includes("truncated"));
  assert.equal(summarizeTaskOutput(long, 50), summarizeTaskOutput(long, 50)); // deterministic
  assert.ok(!summary.includes("x".repeat(60))); // tail never travels downstream
});

test("all done → APPROVE with rounds, ordered tasks and copied artifacts", () => {
  const report = buildReport(baseInput());
  assert.equal(report.verdict, SWARM_VERDICTS.APPROVE);
  assert.equal(report.rounds, 2);
  assert.deepEqual(report.tasks.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(report.artifacts, ARTIFACTS);
  assert.equal(report.tasks[1]?.sessionId, "sess-2");
});

test("any failed or suspended after caps → REJECT (fail-closed)", () => {
  const failed = buildReport(baseInput({ tasks: [{ id: "t1", status: "done" }, { id: "t2", status: "failed" }] }));
  assert.equal(failed.verdict, SWARM_VERDICTS.REJECT);
  const suspended = buildReport(baseInput({ tasks: [{ id: "t1", status: "done" }, { id: "t2", status: "suspended" }] }));
  assert.equal(suspended.verdict, SWARM_VERDICTS.REJECT);
});

test("round budget consumed (exhausted) → EXHAUSTED, wins over REJECT signals", () => {
  const exhausted = buildReport(baseInput({ exhausted: true, tasks: [...DONE_TASKS, { id: "t3", status: "failed" }] }));
  assert.equal(exhausted.verdict, SWARM_VERDICTS.EXHAUSTED);
  const suspended = buildReport(baseInput({ exhausted: true, tasks: [...DONE_TASKS, { id: "t3", status: "suspended" }] }));
  assert.equal(suspended.verdict, SWARM_VERDICTS.EXHAUSTED);
  // P5: exhausted flag WITHOUT undone work means work actually converged (after resume)
  const converged = buildReport(baseInput({ exhausted: true }));
  assert.equal(converged.verdict, SWARM_VERDICTS.APPROVE);
});

test("failed/suspended tasks carry no summary or sessionId keys (exactOptional)", () => {
  const report = buildReport(baseInput({ tasks: [{ id: "t9", status: "failed" }] }));
  const task = report.tasks[0];
  assert.equal(task?.status, "failed");
  assert.equal(task === undefined || "summary" in task, false);
  assert.equal(task === undefined || "sessionId" in task, false);
});

test("judge callback is wired: sees the full derived report and may override", () => {
  let seen: unknown;
  const judge: JudgeFn = (report) => {
    seen = report;
    return SWARM_VERDICTS.REJECT;
  };
  const report = buildReport(baseInput(), judge);
  assert.equal(report.verdict, SWARM_VERDICTS.REJECT); // judge overrides APPROVE
  assert.ok(seen !== undefined);
  assert.equal((seen as { rounds: number }).rounds, 2);
  assert.deepEqual((seen as { artifacts: string[] }).artifacts, ARTIFACTS);
});

test("judge returning a non-vocabulary value fails closed to the derived verdict", () => {
  // JudgeFn's return is typed SwarmVerdict, so the non-vocabulary path is only
  // reachable from untyped JS callers — one bridge cast exercises the guard.
  const weird = (() => "TBD") as unknown as JudgeFn;
  const report = buildReport(baseInput(), weird);
  assert.equal(report.verdict, SWARM_VERDICTS.APPROVE);
});

test("judge throwing fails closed to the derived verdict (pipeline never-throw)", () => {
  const report = buildReport(baseInput(), () => {
    throw new Error("judge bug");
  });
  assert.equal(report.verdict, SWARM_VERDICTS.APPROVE);
});