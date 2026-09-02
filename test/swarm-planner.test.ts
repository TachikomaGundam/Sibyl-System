// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// PLAN stage unit tests against a SCRIPTED MOCK CLIENT (engine.test.ts
// convention: the mock mirrors runtime shape path:{id}).
//
// The planner's contract: EVERY failure path — architect persona error,
// unparseable output, schema-validation failure — returns a structured
// {ok:false, stage:"plan", error} and NEVER throws. Parsing uses the verdict
// layer's tolerant extraction (extractVerdictJson) + a hand-rolled strict
// schema validator (mirrors src/verdict validateVerdict style).

import { test } from "node:test";
import assert from "node:assert/strict";

import { planWorkflow, buildPlanInstruction, validateWorkflowSchema } from "../src/swarm/planner.ts";
import type { PlanOptions } from "../src/swarm/planner.ts";
import type { EngineClient } from "../src/engine/index.ts";

const DIRECTORY = "/repo-work";
const MODEL = { providerID: "acme-provider", modelID: "acme-model-a" };
const ARCHITECT = { agent: "architect" };

type PromptResponse = {
  data?: {
    info?: { providerID?: string; modelID?: string; error?: unknown };
    parts?: { type: string; text?: string }[];
  };
  error?: unknown;
};
type CreateResponse = { data?: { id?: string }; error?: unknown };

type Script = {
  create?: () => CreateResponse | Promise<CreateResponse>;
  prompt?: (text: string) => PromptResponse | Promise<PromptResponse>;
};

function scriptedClient(script: Script) {
  const calls: string[] = [];
  const client: EngineClient = {
    session: {
      async create() {
        return (script.create ?? (() => ({ data: { id: "sess-plan" } })))();
      },
      async prompt(args) {
        calls.push(args.body.parts[0]?.text ?? "");
        const text = calls[calls.length - 1] ?? "";
        return (script.prompt ?? (() => ({ data: { parts: [] } })))(text.includes("GOAL") ? text : text);
      },
    },
  };
  return { client, calls };
}

const OK_JSON = JSON.stringify({
  tasks: [
    { id: "t1", title: "scout", instructions: "map the risks", dependsOn: [] },
    { id: "t2", title: "hunt", instructions: "attack the risks", dependsOn: ["t1"] },
  ],
  concurrency: 2,
  notes: "two-phase audit",
});

const baseOpts = (client: EngineClient, over: Partial<PlanOptions> = {}) => ({
  client,
  directory: DIRECTORY,
  architectPersona: ARCHITECT,
  model: MODEL,
  goal: "find the flaw",
  artifact: "artifact.md",
  ...over,
});

test("happy path: fenced JSON schema parses, strict shape preserved", async () => {
  const { client, calls } = scriptedClient({ prompt: () => ({ data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: `Here you go:\n\n\`\`\`json\n${OK_JSON}\n\`\`\`\n\ntrailing chat` }] } }) });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.schema.tasks.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(result.schema.tasks[1]?.dependsOn, ["t1"]);
  assert.equal(result.schema.concurrency, 2);
  assert.equal(result.schema.notes, "two-phase audit");
  // the architect instruction is a strict-JSON contract; assert the structural
  // tokens the runtime parses on (never prose).
  const instruction = calls[0] ?? "";
  assert.ok(instruction.includes("concurrency"));
  assert.ok(instruction.includes("dependsOn"));
  assert.ok(instruction.includes("GOAL: find the flaw"));
  assert.ok(instruction.includes("ARTIFACT: artifact.md"));
});

test("notes omitted: schema carries no notes key (exactOptionalPropertyTypes)", async () => {
  const { client } = scriptedClient({
    prompt: () => ({ data: { parts: [{ type: "text", text: JSON.stringify({ tasks: [{ id: "t1", title: "x", instructions: "y", dependsOn: [] }], concurrency: 1 }) }] } }),
  });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal("notes" in result.schema, false);
});

test("prose-only architect output: structured plan error, never throws", async () => {
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: "I would split this into three stages." }] } }) });
  let result;
  try {
    result = await planWorkflow(baseOpts(client));
  } catch (e) {
    assert.fail(`planWorkflow threw: ${String(e)}`);
  }
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.length > 0);
});

test("invalid schema (missing concurrency): structured error naming the field", async () => {
  const { client } = scriptedClient({
    prompt: () => ({ data: { parts: [{ type: "text", text: JSON.stringify({ tasks: [{ id: "t1", title: "x", instructions: "y", dependsOn: [] }] }) }] } }),
  });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("concurrency"));
});

test("unknown dependsOn reference: validation error, not a crash", async () => {
  const { client } = scriptedClient({
    prompt: () => ({ data: { parts: [{ type: "text", text: JSON.stringify({ tasks: [{ id: "t1", title: "x", instructions: "y", dependsOn: ["ghost"] }], concurrency: 1 }) }] } }),
  });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('references unknown task id "ghost"'));
});

test("forward dependsOn reference is VALID (existence contract, not ordering)", async () => {
  const checked = validateWorkflowSchema({
    tasks: [
      { id: "t1", title: "x", instructions: "depends on the later task", dependsOn: ["t2"] },
      { id: "t2", title: "y", instructions: "z", dependsOn: [] },
    ],
    concurrency: 2,
  });
  assert.equal(checked.ok, true);
});

test("duplicate task id and extra top-level key: both rejected", async () => {
  const dup = validateWorkflowSchema({
    tasks: [
      { id: "t1", title: "x", instructions: "y", dependsOn: [] },
      { id: "t1", title: "x2", instructions: "y2", dependsOn: [] },
    ],
    concurrency: 1,
  });
  assert.equal(dup.ok, false);
  assert.ok(dup.ok === false && dup.error.includes('duplicate task id "t1"'));
  const extra = validateWorkflowSchema({ tasks: [{ id: "t1", title: "x", instructions: "y", dependsOn: [] }], concurrency: 1, budget: 9 });
  assert.equal(extra.ok, false);
  assert.ok(extra.ok === false && extra.error.includes('unknown top-level key "budget"'));
});

test("architect persona failure (create error): structured plan error, no throw", async () => {
  const { client } = scriptedClient({ create: () => ({ error: { message: "create boom" } }) });
  let result;
  try {
    result = await planWorkflow(baseOpts(client));
  } catch (e) {
    assert.fail(`planWorkflow threw: ${String(e)}`);
  }
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("create boom"));
});

test("malformed JSON (balanced but unparseable): extraction refuses it, structured plan error", async () => {
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: '{"tasks": [BROKEN]}' }] } }) });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("no JSON object"));
});

test("unbalanced-brace JSON: extraction yields nothing, structured error", async () => {
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: '{"tasks": [BROKEN' }] } }) });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.length > 0);
});

test("mock rejecting mid-flight: caught, structured plan error", async () => {
  const { client } = scriptedClient({
    prompt: () => {
      throw new Error("mock exploded");
    },
  });
  const result = await planWorkflow(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("mock exploded"));
});

test("buildPlanInstruction embeds goal and artifact verbatim", () => {
  const instruction = buildPlanInstruction("audit X", "path/to/artifact");
  assert.ok(instruction.includes("audit X"));
  assert.ok(instruction.includes("path/to/artifact"));
});

// --- repair one-shot: plan §75 verdict-layer repair PATTERN applied to the schema pass ---

const GOOD_SCHEMA = JSON.stringify({
  tasks: [{ id: "t1", title: "x", instructions: "y", dependsOn: [] }],
  concurrency: 1,
});

test("repair not consulted when the first attempt already parses (happy path untouched)", async () => {
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: OK_JSON }] } }) });
  let repairCalls = 0;
  const result = await planWorkflow(
    baseOpts(client, { repair: async () => { repairCalls += 1; return GOOD_SCHEMA; } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(repairCalls, 0);
  assert.deepEqual(result.schema.tasks.map((t) => t.id), ["t1", "t2"]);
});

test("invalid schema + repair returning valid schema JSON: ok:true, repair called once with the reason", async () => {
  const bad = JSON.stringify({ tasks: [], concurrency: 1 });
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: bad }] } }) });
  const seenWhys: string[] = [];
  const result = await planWorkflow(
    baseOpts(client, {
      repair: async (_badText, why) => { seenWhys.push(why); return GOOD_SCHEMA; },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(seenWhys.length, 1);
  assert.ok(seenWhys[0]!.includes("tasks must be a non-empty array"));
  assert.deepEqual(result.schema.tasks.map((t) => t.id), ["t1"]);
});

test("repair throwing: fail-closed with chained plan-repair-failed reason", async () => {
  const bad = JSON.stringify({ tasks: [], concurrency: 1 });
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: bad }] } }) });
  const result = await planWorkflow(
    baseOpts(client, {
      repair: async () => { throw new Error("model quota exceeded"); },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("tasks must be a non-empty array"));
  assert.ok(result.error!.includes("+ plan-repair-failed: model quota exceeded"));
});

test("repair output still invalid: fail-closed with chained plan-repair-invalid reason", async () => {
  const bad = JSON.stringify({ tasks: [], concurrency: 1 });
  const { client } = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: bad }] } }) });
  const result = await planWorkflow(
    baseOpts(client, { repair: async () => "still no json here" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "plan");
  assert.ok(result.error!.includes("plan-repair-invalid: architect output contained no JSON object"));
});

test("unparseable first attempt: repair called EXACTLY once and its output re-parses", async () => {
  const { client } = scriptedClient({
    prompt: () => ({ data: { parts: [{ type: "text", text: "I would split this into three stages." }] } }),
  });
  const seenWhys: string[] = [];
  const result = await planWorkflow(
    baseOpts(client, {
      repair: async (_badText, why) => { seenWhys.push(why); return GOOD_SCHEMA; },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(seenWhys.length, 1);
  assert.ok(seenWhys[0]!.includes("no JSON object"));
  assert.deepEqual(result.schema.tasks.map((t) => t.id), ["t1"]);
});

test("no repair provided: identical structured errors as before (regression)", async () => {
  const prose = scriptedClient({ prompt: () => ({ data: { parts: [{ type: "text", text: "sorry, all prose here" }] } }) });
  const r1 = await planWorkflow(baseOpts(prose.client));
  assert.equal(r1.ok, false);
  if (r1.ok) return;
  assert.equal(r1.error, "architect output contained no JSON object");

  const badSchema = scriptedClient({
    prompt: () => ({ data: { parts: [{ type: "text", text: JSON.stringify({ tasks: [], concurrency: 1 }) }] } }),
  });
  const r2 = await planWorkflow(baseOpts(badSchema.client));
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.error, "workflow schema invalid: tasks must be a non-empty array, got array(0)");
});