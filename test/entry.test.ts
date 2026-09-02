// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// Plugin-entry tests: registration surface (exactly the three sibyl tools, no
// placeholder), the LOUD disable path on invalid config (learnings #3: plugin
// load failures are silent in the host), the SIBYL_STATE_FILE seam reaching the
// entry-constructed RunStore, the toEngineClient SDK->EngineClient normalizer
// against runtime-shaped union returns, and the zero-team-mode-refs grep gate.
// The full consult write path through the entry is exercised offline by
// .omo/evidence/t8/entry-probe.mjs against the built dist bundle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";
import SibylPlugin, { toEngineClient } from "../src/index.ts";
import type { EngineClient } from "../src/engine/index.ts";

type Handler = (args: { body: { title: string } } | { body: unknown }) => unknown;

function fakeSdkClient(handlers: {
  create?: Handler;
  prompt?: Handler;
}) {
  const calls: { create: unknown[]; prompt: unknown[] } = { create: [], prompt: [] };
  const sdk = {
    session: {
      create: (args: { body: { title: string } }) => {
        calls.create.push(args);
        return Promise.resolve(
          handlers.create === undefined
            ? { data: { id: "sdk-1" }, error: undefined, response: {}, request: {} }
            : (handlers.create(args) as object),
        );
      },
      prompt: (args: { body: unknown }) => {
        calls.prompt.push(args);
        return Promise.resolve(
          handlers.prompt === undefined
            ? { data: { info: { providerID: "p", modelID: "m", error: undefined }, parts: [{ type: "text", text: "hi", id: "pt1", sessionID: "sdk-1" }] }, error: undefined, response: {}, request: {} }
            : (handlers.prompt(args) as object),
        );
      },
    },
  };
  return { sdk: sdk as unknown as PluginInput["client"], calls };
}

const fakeInput = (client: PluginInput["client"]): PluginInput =>
  ({ client, directory: "/proj", worktree: "/proj", project: { id: "pr" } }) as unknown as PluginInput;

test("entry registers exactly sibyl_consult, sibyl_swarm, sibyl_status — no placeholder", async () => {
  const { sdk } = fakeSdkClient({});
  const hooks = await SibylPlugin(fakeInput(sdk), undefined);
  const names = Object.keys(hooks.tool ?? {}).sort();
  assert.deepEqual(names, ["sibyl_consult", "sibyl_status", "sibyl_swarm"]);
  const consult = hooks.tool?.["sibyl_consult"];
  assert.ok(consult !== undefined && typeof consult.execute === "function" && typeof consult.description === "string");
  assert.deepEqual(Object.keys(consult.args).sort(), ["artifact", "goal"]);
  const swarm = hooks.tool?.["sibyl_swarm"];
  assert.ok(swarm !== undefined);
  assert.deepEqual(Object.keys(swarm.args).sort(), ["artifact", "goal", "judge"]);
  const status = hooks.tool?.["sibyl_status"];
  assert.ok(status !== undefined);
  assert.deepEqual(Object.keys(status.args), ["runId"]);
});

test("entry: invalid config disables LOUDLY (console.error per issue + DISABLED) and registers nothing", async () => {
  const { sdk } = fakeSdkClient({});
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let hooks: Awaited<ReturnType<typeof SibylPlugin>>;
  try {
    hooks = await SibylPlugin(fakeInput(sdk), { maxRounds: 0, concurrencyK: 99 });
  } finally {
    console.error = real;
  }
  assert.deepEqual(hooks, {});
  assert.ok(lines.some((l) => l.includes("maxRounds")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("concurrencyK")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("SIBYL plugin DISABLED")), lines.join("\n"));
});

test("entry: SIBYL_STATE_FILE seam reaches the store used by the registered tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-entry-"));
  const stateFile = join(dir, "runs.json");
  const prev = process.env["SIBYL_STATE_FILE"];
  process.env["SIBYL_STATE_FILE"] = stateFile;
  try {
    const { sdk } = fakeSdkClient({});
    const hooks = await SibylPlugin(fakeInput(sdk), undefined);
    const status = hooks.tool?.["sibyl_status"];
    assert.ok(status !== undefined);
    const out = (await status.execute(
      { runId: "sibyl-absent" },
      // The real host passes the full SDK ToolContext; the tool only reads
      // {directory, abort} (ToolContextLike), so the mock carries those.
      { directory: "/proj", abort: new AbortController().signal } as unknown as Parameters<typeof status.execute>[1],
    )) as string;
    assert.ok(out.includes(stateFile), out); // resolved via the env seam
  } finally {
    if (prev === undefined) delete process.env["SIBYL_STATE_FILE"];
    else process.env["SIBYL_STATE_FILE"] = prev;
  }
});

test("toEngineClient: unions with required undefined arms normalize to EngineClient optional bags", async () => {
  const { sdk, calls } = fakeSdkClient({});
  const client: EngineClient = toEngineClient(sdk);

  const created = await client.session.create({ body: { title: "sibyl:t" }, query: { directory: "/d" } });
  assert.deepEqual(created, { data: { id: "sdk-1" } }); // error/response/request stripped
  assert.deepEqual(calls.create[0], { body: { title: "sibyl:t" }, query: { directory: "/d" } });

  const prompted = await client.session.prompt({
    path: { id: "sdk-1" },
    body: { model: { providerID: "p", modelID: "m" }, tools: { bash: false }, parts: [{ type: "text", text: "go" }] },
    query: { directory: "/d" },
  });
  assert.deepEqual(prompted, {
    data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "hi" }] },
  }); // info.error:undefined and extra part fields stripped
  const fwd = calls.prompt[0] as { path: { id: string }; body: { parts: unknown[] } };
  assert.equal(fwd.path.id, "sdk-1"); // runtime seam: path is { id } (learnings #1)

  const { sdk: errSdk } = fakeSdkClient({
    create: () => ({ data: undefined, error: { name: "ApiError" }, response: {}, request: {} }),
  });
  const failed = await toEngineClient(errSdk).session.create({ body: { title: "x" }, query: { directory: "/d" } });
  assert.deepEqual(failed, { error: { name: "ApiError" } }); // data arm absent, error surfaced
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
