// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied. V2 entry + adapter tests written for the opencode 2.x migration
// (docs/V2-MIGRATION.md).
//
// Plugin-entry tests: registration surface (exact tool set, no placeholder),
// the LOUD disable path on invalid config (learnings #3: plugin load failures
// are silent in the host), the SIBYL_STATE_FILE seam reaching the
// entry-constructed RunStore, the toEngineClientV2 seam bridge against
// runtime-shaped 2.x returns (V2 promise client THROWS — the envelope must
// survive), prompt redistribution (switchModel → prompt → wait → context),
// the session-state maps behind the V2 hooks (system injection + fail-closed
// tool-gate), and the zero-team-mode-refs grep gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import SibylPlugin, { createSessionState, toEngineClientV2 } from "../src/index.ts";
import { mapContextMessages } from "../src/v2/adapter.ts";
import { gateToolEvent, injectSessionSystem } from "../src/v2/adapter.ts";
import { errMessage } from "../src/util.ts";
import type { V2Context, V2ContextMessage, V2ToolInfo } from "../src/v2/types.ts";
import type { EngineClient } from "../src/engine/index.ts";

type AnyInput = Record<string, unknown>;

type FakeHandlers = {
  create?: (input: AnyInput) => unknown;
  get?: (input: AnyInput) => unknown;
  context?: (input: AnyInput) => unknown;
  prompt?: (input: AnyInput) => unknown;
  wait?: (input: AnyInput) => unknown;
  switchModel?: (input: AnyInput) => unknown;
  remove?: (input: AnyInput) => unknown;
};

function fakeV2(handlers: FakeHandlers = {}) {
  const calls = {
    create: [] as AnyInput[],
    get: [] as AnyInput[],
    remove: [] as AnyInput[],
    switchModel: [] as AnyInput[],
    prompt: [] as AnyInput[],
    wait: [] as AnyInput[],
    context: [] as AnyInput[],
    add: [] as V2ToolInfo[],
    transforms: 0,
  };
  const hooks: { sessionContext?: (event: unknown) => void; toolBefore?: (event: unknown) => void } = {};
  const dispose: string[] = [];
  const session = {
    create: async (input: AnyInput) => {
      calls.create.push(input);
      return (handlers.create?.(input) ?? { id: "ses-1", location: { directory: "/proj" } }) as never;
    },
    get: async (input: AnyInput) => {
      calls.get.push(input);
      return (handlers.get?.(input) ?? { id: String(input["sessionID"]), location: { directory: "/proj" } }) as never;
    },
    remove: async (input: AnyInput) => {
      calls.remove.push(input);
      return (handlers.remove?.(input) ?? undefined) as never;
    },
    switchModel: async (input: AnyInput) => {
      calls.switchModel.push(input);
      return (handlers.switchModel?.(input) ?? undefined) as never;
    },
    prompt: async (input: AnyInput) => {
      calls.prompt.push(input);
      return (handlers.prompt?.(input) ?? { id: "inbox-1" }) as never;
    },
    wait: async (input: AnyInput) => {
      calls.wait.push(input);
      return (handlers.wait?.(input) ?? undefined) as never;
    },
    context: async (input: AnyInput) => {
      calls.context.push(input);
      return (handlers.context?.(input) ?? []) as never;
    },
    update: async () => undefined,
    hook: async (_name: string, cb: (event: unknown) => void) => {
      hooks.sessionContext = cb;
      return { dispose: async () => { dispose.push("session.context"); } };
    },
  };
  const tool = {
    transform: async (cb: (editor: { add: (t: V2ToolInfo) => void }) => void) => {
      calls.transforms += 1;
      cb({ add: (t) => { calls.add.push(t); } });
      return { dispose: async () => { dispose.push("tool.transform"); } };
    },
    hook: async (_name: string, cb: (event: unknown) => void) => {
      hooks.toolBefore = cb;
      return { dispose: async () => { dispose.push("tool.execute.before"); } };
    },
  };
  const ctx = { location: { directory: "/proj" }, options: undefined, session, tool } as unknown as V2Context;
  return { ctx, calls, hooks, dispose };
}

/** Run setup with the given raw options, capturing console.error. */
async function setupWith(options: unknown) {
  const fake = fakeV2();
  (fake.ctx as unknown as { options: unknown }).options = options;
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  let cleanup: (() => Promise<void> | void) | void;
  try {
    cleanup = (await SibylPlugin.setup(fake.ctx)) as (() => Promise<void> | void) | void;
  } finally {
    console.error = real;
  }
  return { ...fake, lines, cleanup };
}

test("entry: V2 plugin shape — {id, setup} with the sibyl-system id", () => {
  assert.equal(SibylPlugin.id, "sibyl-system");
  assert.equal(typeof SibylPlugin.setup, "function");
});

test("entry registers the full tool surface incl. sibyl_anchor_check — no placeholder", async () => {
  const { calls } = await setupWith(undefined);
  const names = calls.add.map((t) => t.name).sort();
  assert.deepEqual(names, ["sibyl_anchor_check", "sibyl_attribute", "sibyl_audit", "sibyl_consult", "sibyl_review", "sibyl_status", "sibyl_swarm", "sibyl_time_probe"]);
  const consult = calls.add.find((t) => t.name === "sibyl_consult");
  assert.ok(consult !== undefined && typeof consult.execute === "function" && typeof consult.description === "string");
  assert.ok(consult !== undefined && consult.input !== undefined, "consult must carry an input schema");
});

test("entry: invalid config disables LOUDLY (console.error per issue + DISABLED) and registers nothing", async () => {
  const { calls, lines, hooks } = await setupWith({ maxRounds: 0, concurrencyK: 99 });
  assert.equal(calls.transforms, 0, "no transform may run when disabled");
  assert.equal(calls.add.length, 0);
  assert.equal(hooks.sessionContext, undefined, "no hooks may register when disabled");
  assert.equal(hooks.toolBefore, undefined);
  assert.ok(lines.some((l) => l.includes("maxRounds")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("concurrencyK")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("SIBYL plugin DISABLED")), lines.join("\n"));
});

// V2 config passes plugin options verbatim as ctx.options; a nested
// {options:{...}} wrapper is a config bug the strict schema must reject LOUD.
test("entry: wrapper-form {options:{modelPool:...}} disables LOUDLY with zero tools", async () => {
  const { calls, lines } = await setupWith({
    options: { modelPool: { default: { providerID: "anthropic", modelID: "claude-x" } } },
  });
  assert.equal(calls.add.length, 0, "wrapper form must register no tools");
  assert.ok(lines.some((l) => l.includes("options")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("SIBYL plugin DISABLED")), lines.join("\n"));
});

test("entry: direct top-level options reach the schema (maxRounds:2 registers the full set)", async () => {
  const { calls } = await setupWith({ maxRounds: 2 });
  assert.equal(calls.add.length, 8);
});

test("entry: setup returns a cleanup; tools execute through the engine-resolved directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-entry-"));
  const stateFile = join(dir, "runs.json");
  const prev = process.env["SIBYL_STATE_FILE"];
  process.env["SIBYL_STATE_FILE"] = stateFile;
  try {
    const fake = fakeV2();
    const cleanup = (await SibylPlugin.setup(fake.ctx)) as (() => void) | undefined;
    assert.equal(typeof cleanup, "function", "V2 contract: setup returns cleanup");
    const status = fake.calls.add.find((t) => t.name === "sibyl_status");
    assert.ok(status !== undefined);
    const result = await status.execute({ runId: "sibyl-absent" }, { sessionID: "ses_caller", signal: new AbortController().signal });
    assert.ok(result.content.includes(stateFile), result.content); // resolved via the env seam
    assert.ok(fake.calls.get.some((c) => c["sessionID"] === "ses_caller"), "directory resolved from the engine session record");
    cleanup?.();
  } finally {
    if (prev === undefined) delete process.env["SIBYL_STATE_FILE"];
    else process.env["SIBYL_STATE_FILE"] = prev;
  }
});

const assistantMsg: V2ContextMessage = {
  id: "m2",
  type: "assistant",
  time: { created: 2, completed: 3 },
  model: { id: "m", providerID: "p" },
  content: [
    { type: "text", text: "ballot" },
    { type: "tool", name: "write", state: { input: { path: "/x" } } },
  ],
};

test("mapContextMessages: assistant fields + tool parts + user text bodies survive", () => {
  const mapped = mapContextMessages([
    { id: "m1", type: "user", text: "q", time: { created: 1 } },
    assistantMsg,
  ]);
  assert.equal(mapped.length, 2);
  const user = mapped[0];
  const assistant = mapped[1];
  assert.deepEqual(user?.info, { role: "user" });
  assert.deepEqual(user?.parts, [{ type: "text", text: "q" }], "anchor check needs USER text bodies");
  assert.deepEqual(assistant?.info, { role: "assistant", providerID: "p", modelID: "m", time: { created: 2, completed: 3 } });
  assert.deepEqual(assistant?.parts, [
    { type: "text", text: "ballot" },
    { type: "tool", tool: "write", input: { path: "/x" } },
  ], "independence drafting-evidence read needs tool name + input");
});

test("toEngineClientV2: create/parentID/location mapping + throw-to-envelope", async () => {
  const state = createSessionState();
  const { ctx, calls } = fakeV2();
  const client: EngineClient = toEngineClientV2(ctx.session, state);

  const created = await client.session.create({ body: { title: "sibyl:t" }, query: { directory: "/d" } });
  assert.deepEqual(created, { data: { id: "ses-1" } });
  assert.deepEqual(calls.create[0], { title: "sibyl:t", location: { directory: "/d" } });

  await client.session.create({ body: { title: "t2", parentID: "ses_p" }, query: { directory: "/d" } });
  assert.deepEqual(calls.create[1], { title: "t2", parentID: "ses_p", location: { directory: "/d" } });

  const throwing = fakeV2({ create: () => { throw new Error("boom"); } });
  const failed = await toEngineClientV2(throwing.ctx.session, createSessionState()).session.create({
    body: { title: "x" },
    query: { directory: "/d" },
  });
  assert.ok(!("data" in failed) || failed.data === undefined);
  assert.match(String((failed.error as Error)?.message ?? failed.error), /boom/);
});

test("toEngineClientV2: prompt redistribution — gates+systems updated, switchModel→prompt→wait→context", async () => {
  const state = createSessionState();
  const { ctx, calls } = fakeV2({
    context: () => [
      { id: "m1", type: "user", text: "go", time: { created: 1 } },
      assistantMsg,
    ],
  });
  const client = toEngineClientV2(ctx.session, state);

  const prompted = await client.session.prompt({
    path: { id: "ses-1" },
    body: {
      model: { providerID: "p", modelID: "m" },
      system: "PERSONA-SYSTEM",
      tools: { bash: false, edit: false, write: false, read: true },
      parts: [{ type: "text", text: "go" }],
    },
    query: { directory: "/d" },
  });
  assert.deepEqual(prompted, {
    data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "ballot" }] },
  });
  assert.deepEqual(calls.switchModel[0], { sessionID: "ses-1", model: { id: "m", providerID: "p" } });
  assert.deepEqual(calls.prompt[0], { sessionID: "ses-1", text: "go" });
  assert.deepEqual(calls.wait[0], { sessionID: "ses-1" });
  assert.deepEqual([...(state.gates.get("ses-1") ?? [])].sort(), ["bash", "edit", "write"]);
  assert.equal(state.systems.get("ses-1"), "PERSONA-SYSTEM");

  // Follow-up turn without system/gate entries clears the maps (V1 per-turn law).
  await client.session.prompt({
    path: { id: "ses-1" },
    body: { model: { providerID: "p", modelID: "m" }, tools: {}, parts: [{ type: "text", text: "again" }] },
    query: { directory: "/d" },
  });
  assert.equal(state.systems.get("ses-1"), undefined);
  assert.equal(state.gates.get("ses-1")?.size, 0);
});

test("toEngineClientV2: idle-without-assistant is an envelope error, not a fake ballot", async () => {
  const { ctx } = fakeV2({ context: () => [{ id: "m1", type: "user", text: "go", time: { created: 1 } }] });
  const client = toEngineClientV2(ctx.session, createSessionState());
  const res = await client.session.prompt({
    path: { id: "ses-1" },
    body: { model: { providerID: "p", modelID: "m" }, tools: {}, parts: [{ type: "text", text: "go" }] },
    query: { directory: "/d" },
  });
  assert.match(String((res.error as Error)?.message ?? ""), /without an assistant message/);
});

test("toEngineClientV2: idle row error + outcome surface in the envelope (2.2.7 live-probe defect)", async () => {
  const { ctx } = fakeV2({
    context: () => [
      { id: "m1", type: "user", text: "go", time: { created: 1 } },
      { id: "m2", type: "idle", time: { created: 2 }, outcome: "failed", error: { type: "provider.no-route", message: "Model unavailable: /" } },
    ],
  });
  const client = toEngineClientV2(ctx.session, createSessionState());
  const res = await client.session.prompt({
    path: { id: "ses-1" },
    body: { model: { providerID: "p", modelID: "m" }, tools: {}, parts: [{ type: "text", text: "go" }] },
    query: { directory: "/d" },
  });
  const msg = String((res.error as Error)?.message ?? "");
  assert.match(msg, /without an assistant message/);
  assert.match(msg, /outcome=failed/);
  assert.match(msg, /provider\.no-route/);
  assert.match(msg, /Model unavailable/);
});

test("toEngineClientV2: empty model ref skips switchModel (V1 engine-default parity, 2026-11-12 defect)", async () => {
  const { ctx, calls } = fakeV2({
    context: () => [
      { id: "m1", type: "assistant", time: { created: 2, completed: 3 }, model: { id: "engine-default", providerID: "local" }, content: [{ type: "text", text: "ok" }] },
    ],
  });
  const client = toEngineClientV2(ctx.session, createSessionState());
  const res = await client.session.prompt({
    path: { id: "ses-1" },
    body: { model: { providerID: "", modelID: "" }, tools: {}, parts: [{ type: "text", text: "go" }] },
    query: { directory: "/d" },
  });
  assert.equal(calls.switchModel.length, 0, "empty ref must not be persisted onto the session");
  assert.equal(res.data?.info?.providerID, "local");
  assert.equal(res.data?.info?.modelID, "engine-default");
});

test("toEngineClientV2: assistant model error rides info.error (V1 failure channel)", async () => {
  const { ctx } = fakeV2({
    context: () => [{ id: "m2", type: "assistant", time: { created: 2, completed: 3 }, model: { id: "m", providerID: "p" }, error: { type: "api", message: "provider exploded" }, content: [] }],
  });
  const client = toEngineClientV2(ctx.session, createSessionState());
  const res = await client.session.prompt({
    path: { id: "ses-1" },
    body: { model: { providerID: "p", modelID: "m" }, tools: {}, parts: [{ type: "text", text: "go" }] },
    query: { directory: "/d" },
  });
  assert.match(errMessage(res.data?.info?.error), /provider exploded/);
});

test("toEngineClientV2: get forwards parentID; delete removes state; messages maps context", async () => {
  const state = createSessionState();
  const { ctx, calls } = fakeV2({ get: () => ({ id: "ses-9", parentID: "ses_p", location: { directory: "/d" } }) });
  const client = toEngineClientV2(ctx.session, state);

  const got = await client.session.get!({ path: { id: "ses-9" }, query: { directory: "/d" } });
  assert.deepEqual(got, { data: { id: "ses-9", parentID: "ses_p" } });

  state.systems.set("ses-9", "s");
  state.gates.set("ses-9", new Set(["bash"]));
  state.dirs.set("ses-9", "/d");
  await client.session.delete!({ path: { id: "ses-9" }, query: { directory: "/d" } });
  assert.deepEqual(calls.remove[0], { sessionID: "ses-9" });
  assert.equal(state.systems.size + state.gates.size + state.dirs.size, 0, "delete prunes per-session state");

  const { ctx: ctx2 } = fakeV2({ context: () => [{ id: "m1", type: "user", text: "q", time: { created: 1 } }, assistantMsg] });
  const res = await toEngineClientV2(ctx2.session, createSessionState()).session.messages!({
    path: { id: "ses-1" },
    query: { directory: "/d" },
  });
  assert.equal(res.data?.length, 2);
  assert.deepEqual(res.data?.[1]?.parts?.[0], { type: "text", text: "ballot" });
});

test("hooks: context hook injects the persona system; execute.before refuses gated tools only", () => {
  const state = createSessionState();
  state.systems.set("ses-a", "PERSONA");
  state.gates.set("ses-a", new Set(["bash"]));
  const sys = injectSessionSystem(state);
  const event = { sessionID: "ses-a", system: [] as Array<{ type: "text"; text: string }> };
  sys(event);
  assert.deepEqual(event.system, [{ type: "text", text: "PERSONA" }]);
  const other = { sessionID: "ses-human", system: [] as Array<{ type: "text"; text: string }> };
  sys(other);
  assert.deepEqual(other.system, [], "ungated sessions never receive persona text");

  const gate = gateToolEvent(state);
  assert.throws(() => gate({ tool: "bash", sessionID: "ses-a", input: {} }), /disallowed for this seat/);
  gate({ tool: "read", sessionID: "ses-a", input: {} });
  gate({ tool: "bash", sessionID: "ses-human", input: {} });
});

test("grep gate: zero team-mode / oh-my-openagent references anywhere under src/", async () => {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  }
  await walk(join(import.meta.dirname, "..", "src"));
  assert.ok(files.length >= 12, `expected the full src tree, saw ${String(files.length)} files`);
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/team_|oh-my-openagent|teamMode/iu.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("grep gate: zero @opencode-ai (V1) imports under src/ — V2 is structural", async () => {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  }
  await walk(join(import.meta.dirname, "..", "src"));
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/@opencode-ai\//u.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
