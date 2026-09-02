// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_status tests: the tool is a pure read of the store — empty store,
// oldest-first listing with the newest run last, single-run detail by runId,
// unknown run, and the never-throw contract over a CORRUPT state file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseOptions } from "../src/options.ts";
import { RunStore } from "../src/state/index.ts";
import type { RunRecord } from "../src/state/index.ts";
import { statusExecute } from "../src/tools/status.ts";
import type { ToolContextLike, ToolDeps } from "../src/tools/shared.ts";

const CTX: ToolContextLike = { directory: "/st", abort: new AbortController().signal };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-status-"));
  const store = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") });
  const p = parseOptions({});
  assert.ok(p.ok);
  const deps: ToolDeps = {
    client: {
      session: {
        async create() {
          return { data: { id: "never" } };
        },
        async prompt() {
          return { data: { parts: [] } };
        },
      },
    },
    store,
    options: p.options,
  };
  return { deps, store, dir };
}

function rec(partial: { runId: string; createdAt: string; status?: RunRecord["status"]; kind?: RunRecord["kind"]; verdict?: RunRecord["verdict"]; goal?: string }): RunRecord {
  return {
    runId: partial.runId,
    kind: partial.kind ?? "consult",
    artifact: "/art",
    status: partial.status ?? "done",
    spaceDir: join("/spaces", partial.runId),
    createdAt: partial.createdAt,
    updatedAt: partial.createdAt,
    ...(partial.verdict !== undefined && { verdict: partial.verdict }),
    ...(partial.goal !== undefined && { goal: partial.goal }),
  };
}

test("status: empty store reports the resolved store path", async () => {
  const { deps, store } = await fixture();
  const out = await statusExecute(deps, {}, CTX);
  assert.equal(out, `no sibyl runs recorded (store: ${store.runsFile})`);
});

test("status: listing is oldest-first with every record's id, kind, status, verdict", async () => {
  const { deps, store } = await fixture();
  await store.save([
    rec({ runId: "sibyl-old-1", createdAt: "2026-09-01T10:00:00.000Z" }),
    rec({
      runId: "sibyl-new-2",
      createdAt: "2026-09-02T10:00:00.000Z",
      kind: "swarm",
      status: "failed",
      goal: "ship it",
    }),
  ]);
  const out = await statusExecute(deps, {}, CTX);
  const lines = out.split("\n");
  assert.equal(lines[0], "SIBYL RUNS (2, oldest first)");
  assert.ok(lines[1] !== undefined && lines[1].startsWith("sibyl-old-1 consult done"), lines[1]);
  assert.ok(lines[2] !== undefined && lines[2].startsWith("sibyl-new-2 swarm failed"), lines[2]);
  assert.ok(lines[2].includes('goal="ship it"'), lines[2]);
  assert.ok(lines[2].includes("space="), lines[2]);
  assert.ok(out.indexOf("sibyl-old-1") < out.indexOf("sibyl-new-2"), "newest must be last");
});

test("status: runId shows one run; unknown runId is a readable miss", async () => {
  const { deps, store } = await fixture();
  await store.save([
    rec({
      runId: "sibyl-hit-1",
      createdAt: "2026-09-02T09:00:00.000Z",
      verdict: { verdict: "REJECT", approvals: 1, rejects: 2, errors: 0, missing: 0 },
    }),
  ]);
  const found = await statusExecute(deps, { runId: "sibyl-hit-1" }, CTX);
  assert.ok(found.startsWith("SIBYL RUN sibyl-hit-1\n"), found);
  assert.ok(found.includes("REJECT(A1/R2/E0/M0)"), found);

  const miss = await statusExecute(deps, { runId: "sibyl-nope" }, CTX);
  assert.ok(miss.startsWith("SIBYL status: no run sibyl-nope (store:"), miss);
});

test("status: corrupt state file degrades to the empty listing (store.load never throws)", async () => {
  const { deps, store } = await fixture();
  await writeFile(store.runsFile, "{not json!!", "utf8");
  const out = await statusExecute(deps, {}, CTX);
  assert.equal(out, `no sibyl runs recorded (store: ${store.runsFile})`);
});
