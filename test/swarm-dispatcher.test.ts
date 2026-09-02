// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// DISPATCH stage tests against a SCRIPTED MOCK CLIENT + injected FAKE CLOCK —
// zero real sleeps (the only real wait is the per-task engine timeout test,
// 40ms < 50ms budget). Covers: suspend≠fail via the 429 classifier, same-worker
// retry cap, resume-by-id ordering, stagger determinism, fan-in (conclusions
// only, never full drafts), dependency waves, cycle→structured error, ordered
// aggregation under out-of-order completion, and a full PLAN→MINT→DISPATCH→
// AGGREGATE pipeline run. Mock rejections are caught — the dispatcher never
// throws at its public surface.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchRoster, isRateLimitError, resumeDispatch } from "../src/swarm/dispatcher.ts";
import { buildReport } from "../src/swarm/aggregate.ts";
import { planWorkflow } from "../src/swarm/planner.ts";
import { mintRoster } from "../src/swarm/minter.ts";
import { SWARM_VERDICTS } from "../src/swarm/types.ts";
import type { Clock, DispatchOptions } from "../src/swarm/types.ts";
import type { EngineClient } from "../src/engine/index.ts";
import type { ModelPool, PersonaLike, Roster, WorkflowSchema } from "../src/swarm/types.ts";

const DIRECTORY = "/repo-work";
const POOL: ModelPool = {
  fast: { providerID: "acme-provider", modelID: "acme-model-a" },
  strong: { providerID: "acme-provider", modelID: "acme-model-b" },
};
const PERSONAS: PersonaLike[] = [{ agent: "skeptic" }, { agent: "pragmatist" }];

type PromptResponse = {
  data?: {
    info?: { providerID?: string; modelID?: string; error?: unknown };
    parts?: { type: string; text?: string }[];
  };
  error?: unknown;
};

function fakeClock() {
  const delays: number[] = [];
  const clock: Clock = { sleep: async (ms) => { delays.push(ms); } };
  return { clock, delays };
}

type DraftRecord = { taskId: string; workerId: string; text: string };

function scriptedClient(prompt: (text: string) => PromptResponse | Promise<PromptResponse>) {
  const calls: string[] = [];
  const client: EngineClient = {
    session: {
      async create() {
        return { data: { id: `sess-${calls.length}` } };
      },
      async prompt(args) {
        const text = args.body.parts[0]?.text ?? "";
        calls.push(text);
        return prompt(text);
      },
    },
  };
  return { client, calls };
}

function okResponse(text: string): PromptResponse {
  return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text }] } };
}

function schemaOf(tasks: { id: string; instructions: string; dependsOn: string[] }[]): WorkflowSchema {
  return { tasks: tasks.map((t) => ({ ...t, title: t.id })), concurrency: tasks.length };
}

function rosterFor(schema: WorkflowSchema, over: Partial<Parameters<typeof mintRoster>[1]> = {}): Roster {
  const minted = mintRoster(schema, { personas: PERSONAS, modelPool: POOL, timeoutMs: 5_000, ...over });
  // assert.equal's `asserts` signature narrows minted to the ok:true variant
  assert.equal(minted.ok, true);
  return minted.roster;
}

function baseOpts(client: EngineClient, over: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    client,
    directory: DIRECTORY,
    concurrencyK: 2,
    staggerMs: 0,
    writeDraft: async (a) => `/space/${a.taskId}.md`,
    ...over,
  };
}

test("rate-limit classifier: 429 or 'rate' marker is the SUSPEND trigger", () => {
  assert.equal(isRateLimitError("429 Too Many Requests"), true);
  assert.equal(isRateLimitError("rate limit exceeded"), true);
  assert.equal(isRateLimitError("Rate Limiting active"), true);
  assert.equal(isRateLimitError("connection reset"), false);
  assert.equal(isRateLimitError("timeout after 30s"), false);
  assert.equal(isRateLimitError(""), false);
});

test("linear chain: ordered results, drafts written, artifacts in schema order", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "inspect alpha", dependsOn: [] },
    { id: "t2", instructions: "inspect beta", dependsOn: ["t1"] },
  ]);
  const { client, calls } = scriptedClient((text) => okResponse(`draft for ${text.slice(0, 20)}`));
  const drafts: DraftRecord[] = [];
  const result = await dispatchRoster(
    rosterFor(schema),
    baseOpts(client, { writeDraft: async (a) => { drafts.push(a); return `/space/${a.taskId}.md`; } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outcome.tasks.map((t) => [t.id, t.status]), [["t1", "done"], ["t2", "done"]]);
  assert.equal(result.outcome.rounds, 2);
  assert.equal(result.outcome.exhausted, false);
  assert.deepEqual(result.outcome.artifacts, ["/space/t1.md", "/space/t2.md"]);
  assert.equal(drafts.length, 2);
  assert.ok(drafts[0]!.text.startsWith("draft for inspect alpha"));
  assert.equal(result.outcome.tasks[0]!.sessionId, "sess-0");
  // fan-in: t2's prompt carries t1's CONCLUSIONS, addressed by id
  const t2Prompt = calls.find((c) => c.includes("inspect beta"));
  assert.ok(t2Prompt!.includes("Upstream conclusions"));
  assert.ok(t2Prompt!.includes("- t1: draft for inspect alpha"));
});

test("fan-in shards context: downstream gets truncated summary, never the full draft", async () => {
  const longDraft = "RISK".repeat(200); // 800 chars
  const schema = schemaOf([
    { id: "t1", instructions: "investigate", dependsOn: [] },
    { id: "t2", instructions: "report", dependsOn: ["t1"] },
  ]);
  const { client, calls } = scriptedClient((text) => (text.includes("investigate") ? okResponse(longDraft) : okResponse("final")));
  const drafts: DraftRecord[] = [];
  const result = await dispatchRoster(
    rosterFor(schema),
    baseOpts(client, { summaryMaxChars: 40, writeDraft: async (a) => { drafts.push(a); return `/space/${a.taskId}.md`; } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(drafts[0]!.text, longDraft); // full draft goes to disk
  const reportPrompt = calls.find((c) => c.includes("report"));
  assert.ok(reportPrompt!.includes("RISK".repeat(5))); // leading conclusions present
  assert.ok(!reportPrompt!.includes("RISK".repeat(30))); // mid/tail of the draft never travels
  assert.ok(result.outcome.tasks[0]!.summary!.includes("truncated"));
});

test("429 rate-limit: task is SUSPENDED immediately, retry budget NOT burned", async () => {
  const { client, calls } = scriptedClient(() => ({ error: { message: "429 Too Many Requests" } }));
  const result = await dispatchRoster(rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])), baseOpts(client));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "suspended");
  assert.ok(result.outcome.state.tasks[0]!.error!.includes("429"));
  assert.equal(calls.length, 1); // one attempt only — no retry burn on rate-limit
  assert.equal(result.outcome.state.tasks[0]!.attempts, 1);
});

test("non-rate failure is retried same-worker up to the cap, then fails", async () => {
  let failures = 0;
  const { client, calls } = scriptedClient(() => (failures++ < 1 ? { error: { message: "boom" } } : okResponse("recovered")));
  const { clock, delays } = fakeClock();
  const result = await dispatchRoster(
    rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])),
    baseOpts(client, { retryDelayMs: 111, clock }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "done");
  assert.equal(calls.length, 2); // attempt + retry
  assert.ok(delays.includes(111)); // retry delay observed by the fake clock

  let alwaysBoom = 0;
  const { client: c2 } = scriptedClient(() => { alwaysBoom++; return { error: { message: "boom" } }; });
  const failed = await dispatchRoster(rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])), baseOpts(c2, { maxAttempts: 2 }));
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.outcome.tasks[0]!.status, "failed");
  assert.equal(alwaysBoom, 2);
});

test("stagger launch is clock-deterministic: wave of 3 → delays [0, s, 2s]", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "a", dependsOn: [] },
    { id: "t2", instructions: "b", dependsOn: [] },
    { id: "t3", instructions: "c", dependsOn: [] },
  ]);
  const { client } = scriptedClient(() => okResponse("d"));
  const { clock, delays } = fakeClock();
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client, { concurrencyK: 3, staggerMs: 5, clock }));
  assert.equal(result.ok, true);
  assert.deepEqual(delays, [0, 5, 10]);
});

test("dependency respect via waves: with K=1 a dependent never starts before its dep", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "first wave", dependsOn: [] },
    { id: "t2", instructions: "second wave", dependsOn: ["t1"] },
  ]);
  const { client, calls } = scriptedClient(() => okResponse("d"));
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client, { concurrencyK: 1, staggerMs: 0 }));
  assert.equal(result.ok, true);
  assert.ok(calls[0]!.includes("first wave"));
  assert.ok(calls[1]!.includes("second wave"));
  assert.ok(calls[1]!.includes("- t1: d")); // upstream conclusions present at run time
});

test("suspend → resume-by-id ordering: done work is never re-run, rounds keep counting", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "run stable analysis", dependsOn: [] },
    { id: "t2", instructions: "run flaky analysis", dependsOn: ["t1"] },
  ]);
  let t2Calls = 0;
  const { client, calls } = scriptedClient((text) =>
    text.includes("run flaky") ? (t2Calls++ === 0 ? { error: { message: "429 rate limit" } } : okResponse("finally")) : okResponse("stable-draft"),
  );
  const first = await dispatchRoster(rosterFor(schema), baseOpts(client));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.outcome.tasks[0]!.status, "done");
  assert.equal(first.outcome.tasks[1]!.status, "suspended");
  assert.equal(first.outcome.rounds, 2);
  const stableCallsAtSuspend = calls.filter((c) => c.includes("run stable analysis")).length;

  const resumed = await resumeDispatch(first.outcome.state, baseOpts(client));
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.deepEqual(resumed.outcome.tasks.map((t) => t.status), ["done", "done"]);
  assert.equal(resumed.outcome.rounds, 3); // budget keeps counting across resume
  assert.equal(resumed.outcome.state.tasks[1]!.attempts, 1); // fresh budget after resume
  assert.equal(calls.filter((c) => c.includes("run stable analysis")).length, stableCallsAtSuspend); // t1 NOT re-run
});

test("resume-to-completion after exhaustion converges to APPROVE (stale exhausted flag regression)", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "phase one", dependsOn: [] },
    { id: "t2", instructions: "phase two", dependsOn: ["t1"] },
  ]);
  const { client } = scriptedClient(() => okResponse("draft"));
  const first = await dispatchRoster(rosterFor(schema), baseOpts(client, { maxRounds: 1 }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.outcome.tasks.map((t) => t.status), ["done", "suspended"]);
  assert.equal(first.outcome.exhausted, true);

  const resumed = await resumeDispatch(first.outcome.state, baseOpts(client, { maxRounds: 10 }));
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.deepEqual(resumed.outcome.tasks.map((t) => t.status), ["done", "done"]);
  assert.equal(resumed.outcome.exhausted, false); // budget sufficed: work fully converged
  const report = buildReport({
    rounds: resumed.outcome.rounds,
    exhausted: resumed.outcome.exhausted,
    tasks: resumed.outcome.tasks,
    artifacts: resumed.outcome.artifacts,
  });
  assert.equal(report.verdict, SWARM_VERDICTS.APPROVE); // all done after resume must NOT report EXHAUSTED
});

test("resume with still-insufficient budget stays EXHAUSTED (fail-closed: suspended work remains)", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "phase one", dependsOn: [] },
    { id: "t2", instructions: "phase two", dependsOn: ["t1"] },
  ]);
  const { client } = scriptedClient(() => okResponse("draft"));
  const first = await dispatchRoster(rosterFor(schema), baseOpts(client, { maxRounds: 1 }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const resumed = await resumeDispatch(first.outcome.state, baseOpts(client, { maxRounds: 1 }));
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.deepEqual(resumed.outcome.tasks.map((t) => t.status), ["done", "suspended"]); // cap re-asserts
  assert.equal(resumed.outcome.exhausted, true);
  const report = buildReport({
    rounds: resumed.outcome.rounds,
    exhausted: resumed.outcome.exhausted,
    tasks: resumed.outcome.tasks,
    artifacts: resumed.outcome.artifacts,
  });
  assert.equal(report.verdict, SWARM_VERDICTS.EXHAUSTED);
});

test("dependency cycle: structured dispatch error, never an infinite loop", async () => {
  const schema = schemaOf([
    { id: "a", instructions: "x", dependsOn: ["b"] },
    { id: "b", instructions: "y", dependsOn: ["a"] },
  ]);
  const { client } = scriptedClient(() => okResponse("d"));
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "dispatch");
  assert.ok(result.error.includes("dependency cycle: a -> b -> a"));
});

test("unknown dependsOn reference and self-loop: structured errors", async () => {
  const unknown = schemaOf([{ id: "a", instructions: "x", dependsOn: ["ghost"] }]);
  const { client } = scriptedClient(() => okResponse("d"));
  const r1 = await dispatchRoster(rosterFor(unknown), baseOpts(client));
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('depends on unknown task id "ghost"'));

  const selfLoop = schemaOf([{ id: "a", instructions: "x", dependsOn: ["a"] }]);
  const r2 = await dispatchRoster(rosterFor(selfLoop), baseOpts(client));
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes("dependency cycle: a -> a"));
});

test("ordered aggregation: results follow schema order despite out-of-order completion", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "slow one", dependsOn: [] },
    { id: "t2", instructions: "quick one", dependsOn: [] },
  ]);
  let resolveT1: ((r: PromptResponse) => void) | undefined;
  const gate = new Promise<PromptResponse>((res) => { resolveT1 = res; });
  const { client } = scriptedClient((text) => {
    if (text.includes("slow one")) return gate;
    resolveT1!(okResponse("slow draft")); // t2 completes first and unblocks t1
    return okResponse("quick draft");
  });
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client, { concurrencyK: 2 }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.id, "t1"); // schema order preserved
  assert.equal(result.outcome.tasks[1]!.id, "t2");
  assert.ok(result.outcome.tasks.every((t) => t.status === "done"));
});

test("draft writer throwing yields a failed task, not a pipeline crash", async () => {
  const { client } = scriptedClient(() => okResponse("d"));
  const result = await dispatchRoster(
    rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])),
    baseOpts(client, { writeDraft: async () => { throw new Error("disk full"); } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "failed");
  assert.equal(result.outcome.state.tasks[0]!.error, "draft write failed: disk full");
});

test("mock rejecting mid-flight: caught by the engine, task fails after the cap", async () => {
  const { client } = scriptedClient(() => { throw new Error("mock kaboom"); });
  let result;
  try {
    result = await dispatchRoster(rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])), baseOpts(client, { maxAttempts: 1 }));
  } catch (e) {
    assert.fail(`dispatchRoster threw: ${String(e)}`);
  }
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "failed");
  assert.ok(result.outcome.state.tasks[0]!.error!.includes("mock kaboom"));
});

test("round budget consumed: remaining work is suspended and the run is exhausted", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "wave one", dependsOn: [] },
    { id: "t2", instructions: "wave two", dependsOn: ["t1"] },
  ]);
  const { client } = scriptedClient(() => okResponse("d"));
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client, { maxRounds: 1 }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.exhausted, true);
  assert.equal(result.outcome.rounds, 1);
  assert.equal(result.outcome.tasks[0]!.status, "done");
  assert.equal(result.outcome.tasks[1]!.status, "suspended");
});

test("blocked downstream: a task whose dep failed is failed as blocked, not stuck", async () => {
  const schema = schemaOf([
    { id: "t1", instructions: "doomed", dependsOn: [] },
    { id: "t2", instructions: "orphan", dependsOn: ["t1"] },
  ]);
  const { client } = scriptedClient(() => ({ error: { message: "boom" } }));
  const result = await dispatchRoster(rosterFor(schema), baseOpts(client, { maxAttempts: 1 }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "failed");
  assert.equal(result.outcome.tasks[1]!.status, "failed");
  assert.equal(result.outcome.state.tasks[1]!.error, "blocked by non-done dependency");
});

test("per-task timeout: engine timeoutMs applies per worker, task fails with 'timeout'", { timeout: 2_000 }, async () => {
  const { client } = scriptedClient(() => new Promise<PromptResponse>(() => {})); // never resolves
  const result = await dispatchRoster(
    rosterFor(schemaOf([{ id: "t1", instructions: "hang", dependsOn: [] }]), { timeoutMs: 40 }),
    baseOpts(client, { maxAttempts: 1 }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.tasks[0]!.status, "failed");
  assert.ok(result.outcome.state.tasks[0]!.error!.includes("timeout"));
});

test("invalid options: structured dispatch error, no throw", async () => {
  const { client } = scriptedClient(() => okResponse("d"));
  const result = await dispatchRoster(rosterFor(schemaOf([{ id: "t1", instructions: "x", dependsOn: [] }])), baseOpts(client, { concurrencyK: 0 }));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "dispatch");
  assert.ok(result.error.includes("concurrencyK"));
});

test("full pipeline PLAN → MINT → DISPATCH → AGGREGATE ends APPROVE with artifacts", async () => {
  const schemaJson = JSON.stringify({
    tasks: [
      { id: "t1", title: "scout", instructions: "inspect the artifact", dependsOn: [] },
      { id: "t2", title: "fix", instructions: "propose changes", dependsOn: ["t1"] },
    ],
    concurrency: 2,
    notes: "two-phase",
  });
  const architect = scriptedClient((text) => (text.includes("GOAL") ? okResponse(`plan: \`\`\`json\n${schemaJson}\n\`\`\``) : okResponse("draft")));
  const planned = await planWorkflow({
    client: architect.client,
    directory: DIRECTORY,
    architectPersona: { agent: "architect" },
    model: POOL.fast!,
    goal: "improve the artifact",
    artifact: "/tmp/artifact.md",
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const roster = rosterFor(planned.schema);
  const dispatched = await dispatchRoster(roster, baseOpts(architect.client));
  assert.equal(dispatched.ok, true);
  if (!dispatched.ok) return;
  const report = buildReport({
    rounds: dispatched.outcome.rounds,
    exhausted: dispatched.outcome.exhausted,
    tasks: dispatched.outcome.tasks,
    artifacts: dispatched.outcome.artifacts,
  });
  assert.equal(report.verdict, SWARM_VERDICTS.APPROVE);
  assert.deepEqual(report.tasks.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(report.artifacts, ["/space/t1.md", "/space/t2.md"]);
});