// provenance: original clean-room implementation per spike/GO.md contract, no external code copied
//
// Engine layer unit tests against a SCRIPTED MOCK CLIENT.
//
// MOCK SHAPE TRAP (learnings #1): at runtime session.prompt is called with
// `path: { id }` even though types.gen.d.ts names the param `sessionID` — the
// mock mirrors runtime, and the happy-path test asserts the engine really
// passes `path: { id }`.
//
// exactOptionalPropertyTypes is ON: scripted responses omit absent keys
// (writing `data: undefined` would be a type error — `{}` IS the malformed
// "neither data nor error" case, see the malformed-input test).
//
// No `as any`, no `@ts-ignore` anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runPersona, type EngineClient, type PersonaRunResult } from "../src/engine/index.ts";

const MODEL = { providerID: "acme-provider", modelID: "acme-model-a" };
const DIRECTORY = "/repo-work";

type PromptArgs = {
  path: { id: string };
  body: {
    model: { providerID: string; modelID: string };
    agent?: string;
    system?: string;
    tools: Record<string, boolean>;
    parts: { type: "text"; text: string }[];
  };
  query: { directory: string };
};
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
  prompt?: (args: PromptArgs) => PromptResponse | Promise<PromptResponse>;
};

/** Build an EngineClient whose per-call behavior is scripted; records every call. */
function scriptedClient(script: Script) {
  const calls = { create: [] as { body: { title: string }; query: { directory: string } }[], prompt: [] as PromptArgs[] };
  const client: EngineClient = {
    session: {
      async create(args) {
        calls.create.push(args);
        return (script.create ?? (() => ({ data: { id: "sess-test-1" } })))();
      },
      async prompt(args) {
        calls.prompt.push(args);
        return (
          script.prompt ??
          (() => ({
            data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "hello" }] },
          }))
        )(args);
      },
    },
  };
  return { client, calls };
}

const baseOpts = (client: EngineClient): Parameters<typeof runPersona>[0] => ({
  client,
  directory: DIRECTORY,
  persona: { agent: "skeptic" },
  model: MODEL,
  inputText: "audit this artifact",
});

test("happy path: creates session, prompts with path:{id}, joins text parts, ok:true", async () => {
  const { client, calls } = scriptedClient({
    create: () => ({ data: { id: "sess-happy-1" } }),
    prompt: () => ({
      data: {
        info: { providerID: "acme-provider", modelID: "acme-model-a" },
        parts: [
          { type: "text", text: "foo" },
          { type: "tool", text: "ignored" },
          { type: "text" }, // no text key — filtered by the typeof guard
          { type: "text", text: "bar" },
        ],
      },
    }),
  });
  const result = await runPersona({
    client,
    directory: DIRECTORY,
    persona: { agent: "skeptic", system: "Be adversarial." },
    model: MODEL,
    inputText: "audit this artifact",
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "foobar"); // join("") over text parts only
  assert.equal(result.modelApplied, "acme-provider/acme-model-a");
  assert.equal(result.sessionID, "sess-happy-1");
  assert.ok(result.latencyMs >= 0);
  // exactOptionalPropertyTypes: success carries NO stage/error keys at all.
  assert.equal("stage" in result, false);
  assert.equal("error" in result, false);
  assert.deepEqual(calls.create[0], {
    body: { title: "sibyl:skeptic" },
    query: { directory: DIRECTORY },
  });
  assert.deepEqual(calls.prompt[0]!.path, { id: "sess-happy-1" }); // MOCK SHAPE TRAP
  assert.deepEqual(calls.prompt[0]!.body.model, MODEL);
  assert.equal(calls.prompt[0]!.body.agent, "skeptic");
  assert.equal(calls.prompt[0]!.body.system, "Be adversarial.");
  assert.deepEqual(calls.prompt[0]!.body.parts, [{ type: "text", text: "audit this artifact" }]);
});

test("no agent: title falls back to sibyl:persona and agent key is absent (not undefined)", async () => {
  const { client, calls } = scriptedClient({});
  const result = await runPersona({ ...baseOpts(client), persona: {} });
  assert.equal(result.ok, true);
  assert.equal(calls.create[0]!.body.title, "sibyl:persona");
  assert.equal("agent" in calls.prompt[0]!.body, false);
  assert.equal("system" in calls.prompt[0]!.body, false);
});

test("create error: structured ok:false stage=create, prompt never called", async () => {
  const { client, calls } = scriptedClient({ create: () => ({ error: { message: "create boom" } }) });
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "create");
  assert.ok(result.error!.includes("create boom"));
  assert.equal(result.sessionID, "");
  assert.equal(result.text, "");
  assert.equal(result.modelApplied, null);
  assert.ok(result.latencyMs >= 0);
  assert.equal(calls.prompt.length, 0);
});

test("create returns no id: ok:false stage=create, prompt never called", async () => {
  const { client, calls } = scriptedClient({ create: () => ({ data: {} }) });
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "create");
  assert.ok(result.error!.includes("data.id"));
  assert.equal(calls.prompt.length, 0);
});

test("prompt transport error (res.error): ok:false stage=prompt", async () => {
  const { client } = scriptedClient({ prompt: () => ({ error: "prompt exploded" }) });
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "prompt");
  assert.ok(result.error!.includes("prompt exploded"));
});

test("child LLM failure (data.info.error): ok:false stage=prompt", async () => {
  const { client } = scriptedClient({
    prompt: () => ({ data: { info: { providerID: "p", modelID: "m", error: { message: "child failed" } } } }),
  });
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "prompt");
  assert.ok(result.error!.includes("child failed"));
});

test("malformed prompt response (neither data nor error): ok:false, no crash", async () => {
  const { client } = scriptedClient({ prompt: () => ({}) }); // { data: undefined, error: undefined }
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "prompt");
  assert.ok(result.error!.length > 0);
});

test("empty parts: ok:true text:'' (documented: a text projection, not an infrastructure failure)", async () => {
  const { client } = scriptedClient({ prompt: () => ({ data: { info: { providerID: "p", modelID: "m" }, parts: [] } }) });
  const result = await runPersona(baseOpts(client));
  assert.equal(result.ok, true);
  assert.equal(result.text, "");
  assert.equal(result.modelApplied, "p/m");
});

test("disallowedTools: default maps bash/edit/write to false; custom override wins", async () => {
  const { client, calls } = scriptedClient({});
  const defaults = await runPersona(baseOpts(client));
  assert.equal(defaults.ok, true);
  assert.deepEqual(calls.prompt[0]!.body.tools, { bash: false, edit: false, write: false });

  calls.prompt.length = 0;
  const custom = await runPersona({ ...baseOpts(client), persona: { disallowedTools: ["bash"] } });
  assert.equal(custom.ok, true);
  assert.deepEqual(calls.prompt[0]!.body.tools, { bash: false });
});

test("timeout: hanging prompt yields ok:false stage=prompt with 'timeout' error, finishes < 2s", { timeout: 2_000 }, async () => {
  const { client } = scriptedClient({ prompt: () => new Promise<PromptResponse>(() => {}) }); // never resolves
  const w0 = Date.now();
  const result = await runPersona({ ...baseOpts(client), timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "prompt");
  assert.ok(result.error!.includes("timeout"));
  assert.ok(Date.now() - w0 < 2_000, `took ${Date.now() - w0}ms`); // margins generous, never exact ms
});

test("timeout: hanging create yields ok:false stage=create with 'timeout' error", { timeout: 2_000 }, async () => {
  const { client, calls } = scriptedClient({ create: () => new Promise<CreateResponse>(() => {}) });
  const result = await runPersona({ ...baseOpts(client), timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "create");
  assert.ok(result.error!.includes("timeout"));
  assert.equal(calls.prompt.length, 0);
});

test("client throwing: runPersona never throws, surfaces as structured ok:false", async () => {
  const { client } = scriptedClient({ prompt: () => {
    throw new Error("kaboom");
  } });
  let result: PersonaRunResult | undefined;
  try {
    result = await runPersona(baseOpts(client)); // would fail this test loudly if thrown
  } catch (e) {
    assert.fail(`runPersona threw: ${String(e)}`);
  }
  assert.equal(result!.ok, false);
  assert.ok(result!.error!.includes("kaboom"));
});

test("concurrent safety: 3 parallel runPersona calls stay isolated (council Promise.all contract)", async () => {
  let nextId = 0;
  const { client, calls } = scriptedClient({
    create: () => ({ data: { id: `sess-${++nextId}` } }),
    prompt: (args) => ({
      data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: args.body.parts[0]?.text ?? "" }] },
    }),
  });
  const inputs = ["A", "B", "C"].map((tag) => ({ inputText: `audit ${tag}`, agent: `agent-${tag}` }));
  const results = await Promise.all(
    inputs.map((i) => runPersona({ ...baseOpts(client), persona: { agent: i.agent }, inputText: i.inputText })),
  );
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(results.map((r) => r.text), ["audit A", "audit B", "audit C"]); // no cross-call bleed
  assert.equal(calls.create.length, 3);
  assert.equal(new Set(calls.prompt.map((p) => p.path.id)).size, 3); // distinct child sessions
});

test("EngineClient accepts a generic SDK-shaped client structurally (no as any)", async () => {
  // Widest plausible SDK shape: Record-typed params, extra `response` field,
  // optional bags everywhere. If this compiles, both real ctx.client and
  // mocks satisfy the EngineClient seam.
  const sdkShaped = {
    session: {
      create: async (): Promise<{ data: { id: string }; response: Record<string, unknown> }> => ({
        data: { id: "s" },
        response: {},
      }),
      prompt: async (): Promise<{ data: Record<string, unknown>; response: Record<string, unknown> }> => ({
        data: {},
        response: {},
      }),
    },
  };
  const client: EngineClient = sdkShaped;
  assert.equal(typeof client.session.create, "function");
  assert.equal(typeof client.session.prompt, "function");
});