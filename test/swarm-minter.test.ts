// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// MINT stage unit tests — DETERMINISTIC worker-spec synthesis. Same schema +
// pool + opts → identical roster; different schema → different roster
// (the F5 gate's derivation contract). Unknown pool slots, empty pool and
// empty persona list are structured mint errors, never throws. NO fixed
// roster constant anywhere — personas/pool arrive as plain parameters.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mintRoster } from "../src/swarm/minter.ts";
import type { ModelPool, PersonaLike, WorkflowSchema } from "../src/swarm/types.ts";

const POOL: ModelPool = {
  fast: { providerID: "acme-provider", modelID: "acme-model-a" },
  strong: { providerID: "acme-provider", modelID: "acme-model-b" },
};
const PERSONAS: PersonaLike[] = [
  { agent: "skeptic", system: "be adversarial" },
  { agent: "pragmatist", system: "be pragmatic" },
];

const SCHEMA: WorkflowSchema = {
  tasks: [
    { id: "t1", title: "scout", instructions: "map risks", dependsOn: [] },
    { id: "t2", title: "hunt", instructions: "attack risks", dependsOn: ["t1"] },
    { id: "t3", title: "report", instructions: "summarize", dependsOn: ["t2"] },
  ],
  concurrency: 2,
};

test("deterministic: identical schema+pool+opts mint an identical roster", () => {
  const a = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL });
  const b = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.roster, b.roster);
});

test("derived, never constant: different schemas mint different rosters", () => {
  const other: WorkflowSchema = {
    tasks: [{ id: "alpha", title: "x", instructions: "y", dependsOn: [] }],
    concurrency: 1,
  };
  const a = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL });
  const b = mintRoster(other, { personas: PERSONAS, modelPool: POOL });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notDeepEqual(a.roster.workers, b.roster.workers);
  assert.notDeepEqual(a.roster.workers.map((w) => w.workerId), b.roster.workers.map((w) => w.workerId));
});

test("persona rotation: task i gets personas[i % n] and model slots rotate", () => {
  const result = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.roster.workers.length, 3);
  assert.equal(result.roster.workers[0]?.persona.agent, "skeptic");
  assert.equal(result.roster.workers[1]?.persona.agent, "pragmatist");
  assert.equal(result.roster.workers[2]?.persona.agent, "skeptic"); // wraps
  assert.deepEqual(result.roster.workers[0]?.model, POOL.fast);
  assert.deepEqual(result.roster.workers[1]?.model, POOL.strong);
  assert.deepEqual(result.roster.workers[2]?.model, POOL.fast);
  // schema task order is preserved in the roster
  assert.deepEqual(result.roster.workers.map((w) => w.taskId), ["t1", "t2", "t3"]);
});

test("slotFor callback is honored; unknown slot is a structured mint error", () => {
  const viaCallback = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL, slotFor: () => "strong" });
  assert.equal(viaCallback.ok, true);
  if (!viaCallback.ok) return;
  assert.ok(viaCallback.roster.workers.every((w) => w.model.modelID === "acme-model-b"));

  const unknown = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL, slotFor: () => "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.stage, "mint");
  assert.ok(unknown.error.includes('unknown model slot "nope"'));
});

test("empty pool / empty persona list: structured errors, never throws", () => {
  const noPool = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: {} });
  assert.equal(noPool.ok, false);
  assert.equal(noPool.stage, "mint");
  assert.ok(noPool.error.includes("empty"));

  const noPersonas = mintRoster(SCHEMA, { personas: [], modelPool: POOL });
  assert.equal(noPersonas.ok, false);
  assert.equal(noPersonas.stage, "mint");
  assert.ok(noPersonas.error.includes("empty"));
});

test("roundBudget and timeoutMs are stamped from options (defaults + overrides)", () => {
  const defaults = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL });
  assert.equal(defaults.ok, true);
  if (!defaults.ok) return;
  assert.equal(defaults.roster.workers[0]?.roundBudget, 3);
  assert.equal(defaults.roster.workers[0]?.timeoutMs, 240_000);

  const overridden = mintRoster(SCHEMA, { personas: PERSONAS, modelPool: POOL, roundBudget: 5, timeoutMs: 30_000 });
  assert.equal(overridden.ok, true);
  if (!overridden.ok) return;
  assert.ok(overridden.roster.workers.every((w) => w.roundBudget === 5 && w.timeoutMs === 30_000));
});

test("worker ids: deterministic slugs survive hostile task ids", () => {
  const weird: WorkflowSchema = {
    tasks: [{ id: "TASK #1 (primary)", title: "x", instructions: "y", dependsOn: [] }],
    concurrency: 1,
  };
  const a = mintRoster(weird, { personas: PERSONAS, modelPool: POOL });
  const b = mintRoster(weird, { personas: PERSONAS, modelPool: POOL });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.roster.workers[0]?.workerId, "worker-0-TASK-1-primary");
  assert.equal(a.roster.workers[0]?.workerId, b.roster.workers[0]?.workerId);
});