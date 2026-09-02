// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_swarm driver tests: scripted sessions over the real PLAN→MINT→DISPATCH
// →AGGREGATE stack (create order is deterministic: sess-1 architect, then
// worker sessions per dispatch wave, judge last). RunStore tmp-isolated.
// No `as any`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineClient } from "../src/engine/index.ts";
import { parseOptions } from "../src/options.ts";
import { RunStore } from "../src/state/index.ts";
import type { PluginOptions } from "../src/options.ts";
import type { RunRecord } from "../src/state/index.ts";
import { swarmExecute } from "../src/tools/swarm.ts";
import type { ToolContextLike, ToolDeps } from "../src/tools/shared.ts";

const SCHEMA = JSON.stringify({
  tasks: [
    { id: "t1", title: "first", instructions: "do the first thing", dependsOn: [] },
    { id: "t2", title: "second", instructions: "do the second thing", dependsOn: ["t1"] },
  ],
  concurrency: 2,
  notes: "two-step plan",
});

type Step = { text?: string; error?: unknown };

function scripted(script: Record<string, Step[]>) {
  let created = 0;
  const prompts: { id: string; text: string }[] = [];
  const client: EngineClient = {
    session: {
      async create() {
        created += 1;
        return { data: { id: `sess-${String(created)}` } };
      },
      async prompt(args) {
        prompts.push({ id: args.path.id, text: args.body.parts[0]?.text ?? "" });
        const next = script[args.path.id]?.shift();
        if (next === undefined) {
          return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "" }] } };
        }
        if (next.error !== undefined) {
          return { data: { info: { providerID: "p", modelID: "m", error: next.error }, parts: [] } };
        }
        return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: next.text ?? "" }] } };
      },
    },
  };
  return { client, prompts, createCount: () => created };
}

function opts(raw: unknown): PluginOptions {
  const p = parseOptions({ timeoutMs: 10_000, staggerMs: 0, ...((raw ?? {}) as Record<string, unknown>) });
  assert.ok(p.ok, JSON.stringify(p));
  return p.options;
}

async function fixture(script: Record<string, Step[]>, raw?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-swarm-"));
  const { client, prompts, createCount } = scripted(script);
  const store = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") });
  const deps: ToolDeps = { client, store, options: opts(raw) };
  const ctx: ToolContextLike = { directory: "/sw", abort: new AbortController().signal };
  return { deps, ctx, dir, prompts, createCount, store };
}

function happyScript(): Record<string, Step[]> {
  return {
    "sess-1": [{ text: SCHEMA }],
    "sess-2": [{ text: "worker one draft body" }],
    "sess-3": [{ text: "worker two draft body" }],
  };
}

async function oneRun(store: RunStore): Promise<RunRecord> {
  const runs = JSON.parse(await readFile(store.runsFile, "utf8")) as RunRecord[];
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.ok(run !== undefined);
  return run;
}

test("swarm happy path: plan->mint->dispatch->aggregate, APPROVE record + draft files", async () => {
  const { deps, ctx, store } = await fixture(happyScript());
  const out = await swarmExecute(deps, { artifact: "goal artifact text\nsecond line", goal: "build it" }, ctx);

  assert.ok(out.startsWith("SIBYL SWARM: APPROVE run sibyl-"), out.slice(0, 80));
  assert.ok(out.includes("done=2 failed=0 suspended=0"), out);
  assert.ok(out.includes("judge=off"), out);
  assert.ok(out.includes("task: t1 done"), out);
  assert.ok(out.includes("task: t2 done"), out);

  const run = await oneRun(store);
  assert.equal(run.kind, "swarm");
  assert.equal(run.status, "done");
  assert.equal(run.rounds, 2); // two dependency waves
  assert.deepEqual(run.verdict, { verdict: "APPROVE", approvals: 2, rejects: 0, errors: 0, missing: 0 });
  assert.ok(run.notes !== undefined && run.notes.includes("t1=done"), run.notes);

  const d1 = await readFile(join(run.spaceDir, "worker-0-t1.draft.md"), "utf8");
  assert.ok(d1.includes("worker one draft body"), d1);
  const d2 = await readFile(join(run.spaceDir, "worker-1-t2.draft.md"), "utf8");
  assert.ok(d2.includes("worker two draft body"), d2);
  assert.ok(out.includes("worker-0-t1.draft.md"), out); // artifact refs echoed
});

test("swarm judge=true: single judge session overrides the derived verdict after gating", async () => {
  const { deps, ctx, prompts, store } = await fixture({
    ...happyScript(),
    "sess-4": [{ text: "REJECT" }],
  });
  const out = await swarmExecute(deps, { artifact: "a\nb", goal: "g", judge: true }, ctx);

  assert.ok(out.startsWith("SIBYL SWARM: REJECT"), out.slice(0, 40));
  assert.ok(out.includes("judge=REJECT (overrides derived APPROVE)"), out);
  const judgeCall = prompts.at(-1);
  assert.ok(judgeCall !== undefined && judgeCall.id === "sess-4");
  assert.ok(judgeCall.text.includes("DERIVED VERDICT: APPROVE"), judgeCall.text);
  assert.ok(judgeCall.text.includes("Respond with EXACTLY one word"), judgeCall.text);

  const run = await oneRun(store);
  assert.ok(run.verdict !== undefined && run.verdict.verdict === "REJECT"); // EXHAUSTED/REJECT tags stay fail-closed
  assert.equal(run.verdict.approvals, 2); // task counts are unaffected by the judge
});

test("swarm judge garbage: unrecognized word keeps the derived verdict (gated by isSwarmVerdict)", async () => {
  const { deps, ctx, store } = await fixture({
    ...happyScript(),
    "sess-4": [{ text: "LGTM, looks great!" }],
  });
  const out = await swarmExecute(deps, { artifact: "a\nb", goal: "g", judge: true }, ctx);
  assert.ok(out.startsWith("SIBYL SWARM: APPROVE"), out.slice(0, 40));
  assert.ok(out.includes("judge=inactive (unrecognized verdict word; derived kept)"), out);
  const run = await oneRun(store);
  assert.ok(run.verdict !== undefined && run.verdict.verdict === "APPROVE");
});

test("swarm plan failure: structured plan error -> run marked failed after ONE fresh-session repair", async () => {
  const { deps, ctx, store, createCount } = await fixture({
    "sess-1": [{ text: "I will plan later, promise" }, { text: "still not JSON" }],
  });
  const out = await swarmExecute(deps, { artifact: "a\nb", goal: "g" }, ctx);

  assert.ok(out.startsWith("SIBYL SWARM: plan failed"), out.slice(0, 60));
  assert.ok(out.includes("marked failed"), out);
  assert.equal(createCount(), 2); // architect + one repair session (plan's seam has no session of its own)
  const run = await oneRun(store);
  assert.equal(run.status, "failed");
  assert.ok(run.notes !== undefined && run.notes.startsWith("plan:"), run.notes);
});

test("swarm worker failure cascade: exhausted retries fail the task, dependent blocked, derived REJECT", async () => {
  const { deps, ctx, store, createCount } = await fixture({
    "sess-1": [{ text: SCHEMA }],
    "sess-2": [{ error: "worker exploded" }], // t1 attempt 1 — each attempt gets a fresh session
    "sess-3": [{ error: "worker exploded again" }], // t1 attempt 2 — retry cap reached -> failed
    // t2 depends on t1: never dispatched (dep not done) -> stays pending, mapped failed.
  });
  const out = await swarmExecute(deps, { artifact: "a\nb", goal: "g" }, ctx);

  assert.ok(out.startsWith("SIBYL SWARM: REJECT"), out.slice(0, 40));
  assert.ok(out.includes("done=0 failed=2 suspended=0"), out);
  assert.ok(out.includes("task: t1 failed"), out);
  assert.ok(out.includes("task: t2 failed"), out);
  assert.equal(createCount(), 3); // architect + 2 t1 attempts; t2 never got a session

  const run = await oneRun(store);
  assert.equal(run.status, "done"); // pipeline completed; the VERDICT carries the failure
  assert.deepEqual(run.verdict, { verdict: "REJECT", approvals: 0, rejects: 2, errors: 0, missing: 0 });
});
