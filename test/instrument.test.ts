// provenance: W3 instrument-version-on-the-ballot locks. The face must hash
// THE EXACT strings the runtime sends (re-derived here from the same single
// sources — if the face ever hashes a stale copy, the recomputation diverges),
// fold deterministically, validate through the record layer (hex + name shape,
// prototype-key laundering refused), and ride the consult/swarm terminal
// records + the receipt face.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COUNCILORS, COUNCILOR_PERSONAS } from "../src/council/index.ts";
import { instrumentFace, rulesLabel, sha256Hex } from "../src/instrument.ts";
import { ARCHITECT_SYSTEM, repairDemand, SWARM_JUDGE_SYSTEM, SWARM_JUDGE_WORD_CONTRACT } from "../src/personas.ts";
import { validateEntry } from "../src/state/record.ts";
import { RunStore, type RunRecord } from "../src/state/index.ts";
import { buildJudgeInput } from "../src/tools/swarm.ts";
import type { SwarmReport } from "../src/swarm/types.ts";

test("face shape: rulesHash 64-hex, the full ruler roster present", () => {
  const face = instrumentFace();
  assert.match(face.rulesHash, /^[0-9a-f]{64}$/);
  const names = Object.keys(face.components).sort();
  for (const id of COUNCILORS) assert.ok(names.includes(`councilor-${id.toLowerCase()}`), id);
  for (const req of ["architect-system", "repair-grammar", "swarm-judge-system", "swarm-judge-word-contract",
    "chamber-evidence-prompt", "chamber-pro-prompt", "chamber-con-prompt", "chamber-rebuttal-prompt", "chamber-judge-prompt"]) {
    assert.ok(names.includes(req), req);
  }
  for (const [name, hash] of Object.entries(face.components)) {
    assert.match(name, /^[a-z0-9-]{1,40}$/);
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});

test("face hashes the live strings, not copies: recompute from sources matches", () => {
  const face = instrumentFace();
  for (const id of COUNCILORS) {
    assert.equal(face.components[`councilor-${id.toLowerCase()}`], sha256Hex(COUNCILOR_PERSONAS[id].system));
  }
  assert.equal(face.components["architect-system"], sha256Hex(ARCHITECT_SYSTEM));
  assert.equal(face.components["swarm-judge-system"], sha256Hex(SWARM_JUDGE_SYSTEM));
  assert.equal(face.components["swarm-judge-word-contract"], sha256Hex(SWARM_JUDGE_WORD_CONTRACT));
  assert.equal(face.components["repair-grammar"], sha256Hex(repairDemand("<parse-failure-why>")));
});

test("the word contract hashed into the face is the one the judge actually receives", () => {
  const report: SwarmReport = { verdict: "APPROVE", rounds: 1, tasks: [], artifacts: [] };
  assert.ok(buildJudgeInput(report).includes(SWARM_JUDGE_WORD_CONTRACT));
  assert.equal(instrumentFace().components["swarm-judge-word-contract"], sha256Hex(SWARM_JUDGE_WORD_CONTRACT));
});

test("fold is deterministic and order-normalized; any component flip moves rulesHash", () => {
  const a = instrumentFace();
  const b = instrumentFace();
  assert.deepEqual(a, b);
  const fold = (comps: Record<string, string>): string =>
    sha256Hex(JSON.stringify(Object.keys(comps).sort().map((n) => [n, comps[n]])));
  assert.equal(a.rulesHash, fold(a.components));
  const flipped = { ...a.components, "councilor-melchior": "0".repeat(64) };
  assert.notEqual(fold(flipped), a.rulesHash);
});

test("rulesLabel renders the compact 12-hex ballot face", () => {
  assert.match(rulesLabel(instrumentFace()), /^rules=[0-9a-f]{12}$/);
});

test("run record validation: instrument roundtrips; malformed shapes are dropped elements", () => {
  const base = { runId: "r1", kind: "consult", artifact: "a", status: "done", spaceDir: "/s", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" };
  const face = instrumentFace();
  const ok = validateEntry({ ...base, instrument: face });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.record.instrument, face);

  for (const bad of [
    { ...base, instrument: { ...face, rulesHash: "nope" } },
    { ...base, instrument: { ...face, components: { ...face.components, "BAD NAME": "0".repeat(64) } } },
    { ...base, instrument: { ...face, components: { ...face.components, "x": "zz" } } },
    { ...base, instrument: "rules=v1" },
  ]) {
    const v = validateEntry(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
  }

  // prototype-laundering guard: an own "__proto__" key must not survive the rebuild
  const dirty = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>;
  const withProto = { ...base, instrument: { rulesHash: face.rulesHash, components: { ...face.components, ...dirty } } };
  const v = validateEntry(withProto);
  assert.equal(v.ok, false); // "__proto__" fails the name shape check -> element dropped, never laundered
});

test("store roundtrip keeps the instrument face byte-exact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-w3-store-"));
  const store = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") });
  const face = instrumentFace();
  const rec: RunRecord = {
    runId: "sibyl-w3-1", kind: "consult", artifact: "a", status: "done",
    spaceDir: dir, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
    instrument: face,
  };
  await store.appendOrUpdate(rec);
  const raw = JSON.parse(await readFile(join(dir, "runs.json"), "utf8")) as RunRecord[];
  assert.deepEqual(raw[0]?.instrument, face);
  const loaded = await store.getRun("sibyl-w3-1");
  assert.deepEqual(loaded?.instrument, face);
});
