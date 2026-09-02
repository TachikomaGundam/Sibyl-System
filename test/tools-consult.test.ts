// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_consult harness tests: direct execute() against scripted multi-session
// mock clients (runtime shape: path:{id}, distinct session ids per create —
// learnings #1/#9) with the RunStore fully tmp-isolated (runsFile + spaceRoot;
// SIBYL_STATE_FILE is the entry-level seam, exercised in entry.test.ts).
// No `as any`; success replies carry no stage/error keys (EOPT).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineClient } from "../src/engine/index.ts";
import { parseOptions } from "../src/options.ts";
import type { PluginOptions } from "../src/options.ts";
import { RunStore } from "../src/state/index.ts";
import type { RunRecord } from "../src/state/index.ts";
import { consultExecute } from "../src/tools/consult.ts";
import type { ToolContextLike, ToolDeps } from "../src/tools/shared.ts";

const M = { providerID: "p0", modelID: "m0" };
const M2 = { providerID: "p1", modelID: "m1" };

function options(raw: unknown): PluginOptions {
  const p = parseOptions(raw);
  assert.ok(p.ok, JSON.stringify(p));
  return p.options;
}

const verdict = (v: "APPROVE" | "REJECT", confidence: number, reason: string, mustFix: string[] = []): string =>
  JSON.stringify({ verdict: v, confidence, reasons: [reason], must_fix: mustFix });

const MEL_REJECT = verdict("REJECT", 0.9, "melchior: correctness hole", ["close the race"]);
const BAL_APPROVE = verdict("APPROVE", 0.8, "balthasar: ships");
const CAS_REJECT = verdict("REJECT", 0.7, "casper: low utility", ["justify complexity"]);

type Step = { text?: string; error?: unknown };

/** Scripted client: create yields DISTINCT sequential session ids; prompts are
 * served from a per-session queue (voters fan out in COUNCILORS order, so
 * sess-1=MELCHIOR, sess-2=BALTHASAR, sess-3=CASPER). */
function councilClient(script: Record<string, Step[]>) {
  let created = 0;
  const prompts: { id: string; text: string; model: { providerID: string; modelID: string } }[] = [];
  const client: EngineClient = {
    session: {
      async create() {
        created += 1;
        return { data: { id: `sess-${String(created)}` } };
      },
      async prompt(args) {
        prompts.push({ id: args.path.id, text: args.body.parts[0]?.text ?? "", model: args.body.model });
        const next = script[args.path.id]?.shift();
        if (next === undefined) {
          return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "" }] } };
        }
        if (next.error !== undefined) {
          return { data: { info: { providerID: "p", modelID: "m", error: next.error }, parts: [] } };
        }
        return {
          data: {
            info: { providerID: "p", modelID: "m" },
            parts: [{ type: "text", text: next.text ?? "" }],
          },
        };
      },
    },
  };
  return { client, prompts };
}

async function fixture(overScript: Record<string, Step[]>, opts?: unknown): Promise<{ deps: ToolDeps; dir: string; prompts: { id: string; text: string; model: { providerID: string; modelID: string } }[] }> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-consult-"));
  const { client, prompts } = councilClient(overScript);
  const deps: ToolDeps = {
    client,
    store: new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") }),
    options: options({ timeoutMs: 10_000, ...((opts ?? {}) as Record<string, unknown>) }),
  };
  return { deps, dir, prompts };
}

const ARTIFACT = "the module under audit\n(second line makes it inline)";

async function loadRuns(store: RunStore): Promise<RunRecord[]> {
  return JSON.parse(await readFile(store.runsFile, "utf8")) as RunRecord[];
}

test("consult 2R/1A: fail-closed REJECT summary, done record, per-voter reply files", async () => {
  const { deps } = await fixture({
    "sess-1": [{ text: MEL_REJECT }],
    "sess-2": [{ text: BAL_APPROVE }],
    "sess-3": [{ text: CAS_REJECT }],
  });
  const out = await consultExecute(deps, { artifact: ARTIFACT, goal: "ship safely" }, { directory: "/srv/work", abort: new AbortController().signal } satisfies ToolContextLike);

  assert.ok(out.startsWith("SIBYL CONSULT: REJECT (votes 1A/2R/0E/0M) run sibyl-"), out.slice(0, 80));
  assert.ok(out.includes("reason: melchior: correctness hole"), out);
  assert.ok(out.includes("must_fix: close the race"), out);
  assert.ok(out.includes("must_fix: justify complexity"), out);

  const runs = await loadRuns(deps.store);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.kind, "consult");
  assert.equal(run.status, "done");
  assert.equal(run.goal, "ship safely");
  assert.ok(run.artifact.startsWith("<inline:"), run.artifact);
  assert.deepEqual(run.verdict, { verdict: "REJECT", approvals: 1, rejects: 2, errors: 0, missing: 0 });
  assert.ok(run.notes !== undefined && run.notes.includes("policy=majority2of3"), run.notes);
  assert.ok(run.notes.includes("MELCHIOR=REJECT"));
  assert.ok(run.notes.includes("CASPER=REJECT"));

  const mel = await readFile(join(run.spaceDir, "MELCHIOR.md"), "utf8");
  assert.ok(mel.includes(MEL_REJECT), mel); // full raw reply persisted
  assert.ok(mel.includes("ballot: REJECT (confidence 0.9)"), mel);
  assert.ok(out.includes(join(run.spaceDir, "MELCHIOR.md")), out); // reply paths echoed
  const cas = await readFile(join(run.spaceDir, "CASPER.md"), "utf8");
  assert.ok(cas.includes(CAS_REJECT), cas);
});

test("consult repair: unparseable voter gets ONE in-session JSON-only follow-up", async () => {
  const { deps, prompts } = await fixture({
    "sess-1": [{ text: MEL_REJECT }],
    "sess-2": [{ text: "this looks fine to me tbh" }, { text: BAL_APPROVE }],
    "sess-3": [{ text: verdict("APPROVE", 0.6, "casper: worth it") }],
  });
  const out = await consultExecute(deps, { artifact: ARTIFACT, goal: "g" }, { directory: "/w", abort: new AbortController().signal });

  assert.ok(out.startsWith("SIBYL CONSULT: APPROVE (votes 2A/1R/0E/0M)"), out.slice(0, 60));
  assert.equal(prompts.length, 4); // 3 ballots + 1 repair
  const repair = prompts[3];
  assert.ok(repair !== undefined);
  assert.equal(repair.id, "sess-2"); // follow-up goes to THAT voter's own session
  assert.ok(repair.text.includes("not a valid verdict JSON"), repair.text);
  assert.ok(repair.text.includes('"verdict":"APPROVE"|"REJECT"'), repair.text);
});

test("consult repair failure: second garbage reply falls through to fail-closed unparseable REJECT", async () => {
  const { deps, prompts } = await fixture({
    "sess-1": [{ text: MEL_REJECT }],
    "sess-2": [{ text: "nope" }, { text: "still nope" }],
    "sess-3": [{ text: BAL_APPROVE }],
  });
  const out = await consultExecute(deps, { artifact: ARTIFACT, goal: "g" }, { directory: "/w", abort: new AbortController().signal });

  assert.ok(out.includes("verdict-unparseable"), out);
  assert.ok(out.startsWith("SIBYL CONSULT: REJECT"), out);
  assert.equal(prompts.length, 4); // exactly ONE repair shot, never a second
  const run = (await loadRuns(deps.store))[0];
  assert.ok(run?.notes !== undefined && run.notes.includes("BALTHASAR=REJECT"), run?.notes);
});

test("consult engine failure: errored voter becomes a fail-closed error vote (2A+1E -> REJECT)", async () => {
  const { deps } = await fixture({
    "sess-1": [{ error: { name: "ProviderAuthError" } }],
    "sess-2": [{ text: BAL_APPROVE }],
    "sess-3": [{ text: verdict("APPROVE", 0.9, "casper: ships") }],
  });
  const out = await consultExecute(deps, { artifact: ARTIFACT, goal: "g" }, { directory: "/w", abort: new AbortController().signal });

  assert.ok(out.startsWith("SIBYL CONSULT: REJECT (votes 2A/0R/1E/0M)"), out.slice(0, 60));
  assert.ok(out.includes("MELCHIOR errored"), out);

  const run = (await loadRuns(deps.store))[0];
  assert.ok(run !== undefined);
  assert.deepEqual(run.verdict, { verdict: "REJECT", approvals: 2, rejects: 0, errors: 1, missing: 0 });
  const reply = await readFile(join(run.spaceDir, "MELCHIOR.md"), "utf8");
  assert.ok(reply.includes("engine call failed"), reply);
  assert.ok(reply.includes("ProviderAuthError"), reply);
});

test("consult artifact read failure: readable error string, NO run record created", async () => {
  const { deps } = await fixture({});
  const ctx: ToolContextLike = { directory: "/nowhere", abort: new AbortController().signal };
  const out = await consultExecute(deps, { artifact: "ghost-file.md", goal: "g" }, ctx);
  assert.ok(out.startsWith("SIBYL consult: artifact"), out);
  assert.ok(out.includes("ghost-file.md"), out);
  let exists = true;
  try {
    await readFile(deps.store.runsFile, "utf8");
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "no store write may happen for a rejected artifact");
});

test("consult fans the three voters out concurrently (one shared Promise.all)", async () => {
  let inflight = 0;
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const client: EngineClient = {
    session: {
      async create() {
        return { data: { id: `s${String(Math.floor(Math.random() * 1e9))}` } };
      },
      async prompt() {
        inflight += 1;
        if (inflight === 3) releaseGate();
        const verdictText = inflight > 0 ? BAL_APPROVE : MEL_REJECT;
        await Promise.race([gate, new Promise((r) => setTimeout(r, 5_000))]);
        return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: verdictText }] } };
      },
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "sibyl-t8-par-"));
  const deps: ToolDeps = {
    client,
    store: new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") }),
    options: options({ timeoutMs: 10_000 }),
  };
  const settled = await Promise.race([
    consultExecute(deps, { artifact: ARTIFACT, goal: "g" }, { directory: dir, abort: new AbortController().signal }).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), 4_000)),
  ]);
  assert.equal(settled, true, "if voters were serialized the latch never opens and this times out");
  assert.equal(inflight, 3);
});

test("consult slot routing: voter override -> persona slot -> pool default", async () => {
  const { deps, prompts } = await fixture(
    {
      "sess-1": [{ text: MEL_REJECT }],
      "sess-2": [{ text: BAL_APPROVE }],
      "sess-3": [{ text: CAS_REJECT }],
    },
    {
      voters: { MELCHIOR: "fastlane", BALTHASAR: "does-not-exist" },
      modelPool: { default: M, melchior: M2, fastlane: { providerID: "pf", modelID: "mf" } },
    },
  );
  await consultExecute(deps, { artifact: ARTIFACT, goal: "g" }, { directory: "/w", abort: new AbortController().signal });
  const bySession = new Map(prompts.map((p) => [p.id, p.model]));
  assert.deepEqual(bySession.get("sess-1"), { providerID: "pf", modelID: "mf" }); // voters override slot
  assert.deepEqual(bySession.get("sess-2"), M); // unknown slot -> pool default, never fatal
  assert.deepEqual(bySession.get("sess-3"), M); // no override, no "casper" pool entry -> default
});
