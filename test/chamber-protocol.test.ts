// provenance: v1.1 chamber tests — the 民主 engine (rounds, receipts, blind
// isolation, terminals L6, kill-injection A2-mechanism) and the 集中 voice
// (ONE conclusion, fail-closed, sealed dissent). Scripted Lane: every role is
// a fake member writing its artifact then reporting process facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  artifactRel,
  parseJudgeRound,
  runChamber,
  type ChamberConfig,
  type ChamberRole,
  type LaunchFacts,
  type Lane,
} from "../src/chamber/protocol.ts";
import { buildVoice, renderVoice, singleVoiceCheck, conclude } from "../src/chamber/synthesis.ts";
import { computeDrawCommit } from "../src/lane/seating.ts";
import { loadLedger } from "../src/state/chamber.ts";

type Behavior = (role: string, message: string, rel: string) => Promise<LaunchFacts> | LaunchFacts;

const TITLE_RE = /-(evidence|pro|con|judge)-r(\d+)-(draft|rebuttal|verdict)$/;

function relFromTitle(title: string): string {
  const m = TITLE_RE.exec(title);
  assert.ok(m !== null, `stub cannot parse title: ${title}`);
  return artifactRel(m[1] as ChamberRole, Number(m[2]), m[3] as "draft" | "rebuttal" | "verdict");
}

function stubLane(behavior: Behavior): Lane & { messages: string[]; killed: string[]; launches: number } {
  const lane = {
    messages: [] as string[],
    killed: [] as string[],
    launches: 0,
    async launch(req: { role: string; title: string; modelId: string; message: string }): Promise<LaunchFacts> {
      lane.launches += 1;
      lane.messages.push(req.message);
      return await behavior(req.role, req.message, relFromTitle(req.title));
    },
    async kill(role: string): Promise<{ ok: boolean }> {
      lane.killed.push(role);
      return { ok: true };
    },
  };
  return lane;
}

const POOL = {
  default: { providerID: "local-qwen", modelID: "m1" },
  alt: { providerID: "local-qwen", modelID: "m2" },
};
const SLOTS: Record<ChamberRole, string> = { evidence: "default", pro: "default", con: "alt", judge: "default" };

function ok(): LaunchFacts {
  return { ok: true, rc: 0, signal: null, timedOut: false };
}
function dead(): LaunchFacts {
  return { ok: false, rc: null, signal: "SIGKILL", timedOut: false };
}
function timeout(): LaunchFacts {
  return { ok: false, rc: null, signal: "SIGKILL", timedOut: true };
}

const JUDGE_CONVERGED = JSON.stringify({
  convergence: "CONVERGED",
  conclusion: "APPROVE",
  confidence: 0.8,
  reasons: ["merit A holds against evidence"],
  must_fix: [],
  charges: [],
});

async function fixture(label: string): Promise<{ dir: string; cfgBase: Omit<ChamberConfig, "lane"> }> {
  const dir = await mkdtemp(join(tmpdir(), `sibyl-proto-${label}-`));
  const runDir = join(dir, "run");
  await mkdir(runDir, { recursive: true });
  const targetPath = join(dir, "target.md");
  await writeFile(targetPath, "# artifact\nclaims to review\n", "utf8");
  return {
    dir,
    cfgBase: {
      runId: `r-${label}`,
      runDir,
      goal: "is the artifact sound",
      targetPath,
      ledgerPath: join(dir, "chamber-ledger.jsonl"),
      seed: "seed-1",
      maxRounds: 3,
      pool: POOL,
      policy: { allowedPrefixes: ["local-"] },
      slots: SLOTS,
      judgePoolIds: ["local-qwen/m1", "local-qwen/m2"],
    },
  };
}

function writer(dir: string, contentFor: (role: string, rel: string) => string | null): Behavior {
  return async (role, _msg, rel) => {
    const content = contentFor(role, rel);
    if (content === null) return role === "judge" ? dead() : ok();
    const abs = join(dir, "run", rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
    return ok();
  };
}

const DEFAULT_CONTENT = (role: string, _rel: string): string | null =>
  role === "judge"
    ? JUDGE_CONVERGED
    : role === "evidence"
      ? `{"probe":"ls","found":"target.md","class":"doc","note":"t"}\n`
      : `## ${role} body ${role.toUpperCase()}-MARKER\ncontent\n`;

test("chamber CONVERGED path: 6 artifacts recorded, ledger serial 1, spotcheck verifies, voice APPROVE", async (t) => {
  const { dir, cfgBase } = await fixture("conv");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(writer(dir, DEFAULT_CONTENT));
  const res = await runChamber({ ...cfgBase, lane });
  assert.equal(res.terminal, "CONVERGED");
  assert.equal(res.record.artifacts.length, 6); // ev + pro + con + 2 rebuttals + judge
  assert.equal(res.record.evidenceRows, 1);
  assert.equal(res.gaps.length, 0);
  const voice = buildVoice(res);
  assert.equal(voice.conclusion, "APPROVE");
  assert.equal(voice.serial, 1);
  const rendered = renderVoice(voice);
  assert.ok(singleVoiceCheck(rendered, res.record).ok, rendered);
  execFileSync("sha256sum", ["-c", "CHECKSUMS.txt"], { cwd: join(dir, "run"), stdio: "pipe" });
  const ledger = await loadLedger(cfgBase.ledgerPath);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]?.terminal, "CONVERGED");
  assert.equal(ledger.dropped.length, 0);
});

test("blind isolation: round-1 pro/con prompts never carry the other's marker; cross-critique DOES", async (t) => {
  const { dir, cfgBase } = await fixture("blind");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(writer(dir, DEFAULT_CONTENT));
  await runChamber({ ...cfgBase, lane });
  const [proDraft, conDraft] = [lane.messages[1] ?? "", lane.messages[2] ?? ""];
  assert.ok(!proDraft.includes("CON-MARKER") && !conDraft.includes("PRO-MARKER"), "drafts are blind");
  const rebs = lane.messages.slice(3, 5);
  assert.ok(rebs.some((m) => m.includes(join(dir, "run", "con", "round-1.md"))), "pro cross-critique is given con's written path");
  assert.ok(rebs.some((m) => m.includes(join(dir, "run", "pro", "round-1.md"))), "con cross-critique is given pro's written path");
});

test("E2 start-line law: drawCommit binds pool+seed and exists on the record at ZERO launches", async (t) => {
  const { dir, cfgBase } = await fixture("draw");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(writer(dir, DEFAULT_CONTENT));
  let commitAtStart = "";
  let launchesAtStart = -1;
  await runChamber({ ...cfgBase, lane }, (rec) => {
    commitAtStart = rec.drawCommit;
    launchesAtStart = lane.launches;
  });
  assert.equal(launchesAtStart, 0, "commit recorded before any launch");
  assert.equal(commitAtStart, computeDrawCommit(cfgBase.judgePoolIds, cfgBase.seed));
});

test("NEEDS_ROUND round 2 then CONVERGED; charges flow into prompts; disagreement log grows", async (t) => {
  const { dir, cfgBase } = await fixture("r2");
  t.after(() => rm(dir, { recursive: true, force: true }));
  let judgeSeen = 0;
  const lane = stubLane(
    writer(dir, (role, rel) => {
      if (role !== "judge") return DEFAULT_CONTENT(role, rel);
      judgeSeen += 1;
      return judgeSeen === 1
        ? JSON.stringify({
            convergence: "NEEDS_ROUND",
            conclusion: "REJECT",
            confidence: 0.4,
            reasons: ["charge N1 uncited"],
            must_fix: ["cite N1"],
            charges: ["N1 uncited claim"],
          })
        : JUDGE_CONVERGED;
    }),
  );
  const res = await runChamber({ ...cfgBase, lane });
  assert.equal(res.terminal, "CONVERGED");
  assert.equal(res.record.rounds, 2);
  const r2Pro = lane.messages.find((m) => m.includes("Prior open charges"));
  assert.ok(r2Pro !== undefined && r2Pro.includes("N1 uncited claim"), "charges flow into the next round");
  const log = await readFile(join(dir, "run", "DISAGREEMENT-LOG.md"), "utf8");
  assert.match(log, /## round 1 — NEEDS_ROUND/);
  assert.match(log, /## round 2 — CONVERGED/);
});

test("A2 mechanism: judge killed mid-phase → MEMBER_LOST, partials kept, voice NEEDS_HUMAN", async (t) => {
  const { dir, cfgBase } = await fixture("kill");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(
    writer(dir, (role, rel) => (role === "judge" ? null : DEFAULT_CONTENT(role, rel))),
  );
  const res = await runChamber({ ...cfgBase, lane, killInjection: { role: "judge", afterMs: 1 } });
  assert.equal(res.terminal, "MEMBER_LOST");
  assert.deepEqual(lane.killed, ["judge"], "kill-injection timer called lane.kill on the judge pgid path");
  assert.equal(res.record.artifacts.length, 6, "five clash receipts survive AND the judge's interim seed is recorded (parseable partial, L5)");
  const jDead = res.record.artifacts.find((a) => a.role === "judge");
  assert.equal(jDead?.signal, "SIGKILL", "the dead judge's receipt carries its process fact, not a clean exit");
  const voice = buildVoice(res);
  assert.equal(voice.conclusion, "NEEDS_HUMAN");
  assert.equal(voice.confidence, 0);
  assert.match(voice.rationale.join(" "), /judge round 1/);
});

test("judge timeout with PARTIAL artifact → TIMEOUT terminal, partial hashed into record", async (t) => {
  const { dir, cfgBase } = await fixture("tmo");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(
    async (role, _msg, rel) => {
      const abs = join(dir, "run", rel);
      await mkdir(join(abs, ".."), { recursive: true });
      if (role === "judge") {
        await writeFile(abs, '{"convergence":"CONVER', "utf8"); // half-written
        return timeout();
      }
      await writeFile(abs, DEFAULT_CONTENT(role, rel) ?? "", "utf8");
      return ok();
    },
  );
  const res = await runChamber({ ...cfgBase, lane });
  assert.equal(res.terminal, "TIMEOUT");
  const jArt = res.record.artifacts.find((a) => a.role === "judge");
  assert.ok(jArt !== undefined && jArt.timedOut, "partial judge artifact recorded");
  assert.equal(buildVoice(res).conclusion, "NEEDS_HUMAN");
});

test("rounds exhausted → NEEDS_ROUND + open charges surface; conclude never defaults to APPROVE", async (t) => {
  const { dir, cfgBase } = await fixture("exh");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane = stubLane(
    writer(dir, (role, rel) => {
      if (role !== "judge") return DEFAULT_CONTENT(role, rel);
      return JSON.stringify({
        convergence: "NEEDS_ROUND",
        conclusion: "REJECT",
        confidence: 0.3,
        reasons: ["unresolved"],
        must_fix: ["x"],
        charges: ["C-open", "D-open"],
      });
    }),
  );
  const res = await runChamber({ ...cfgBase, lane, maxRounds: 2 });
  assert.equal(res.terminal, "NEEDS_ROUND");
  assert.equal(res.record.rounds, 2);
  const voice = buildVoice(res);
  assert.equal(voice.conclusion, "NEEDS_HUMAN");
  assert.equal(voice.open_charges, 2);
  assert.ok(singleVoiceCheck(renderVoice(voice), res.record).ok);
});

test("start-line denials launch NOTHING: denied seat, denied judge pool id, malformed judge JSON grammar", async (t) => {
  const { dir, cfgBase } = await fixture("deny");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lane1 = stubLane(writer(dir, DEFAULT_CONTENT));
  const r1 = await runChamber({
    ...cfgBase,
    lane: lane1,
    pool: { ...POOL, cloud: { providerID: "openai", modelID: "gpt-x" } },
    slots: { ...SLOTS, con: "cloud" },
  });
  assert.equal(lane1.launches, 0, "policy-denied resolved seat => zero launches (E4/F1)");
  assert.equal(r1.terminal, "NEEDS_ROUND");
  assert.match(r1.record.notes ?? "", /seats denied/);

  const lane2 = stubLane(writer(dir, DEFAULT_CONTENT));
  const r2 = await runChamber({ ...cfgBase, lane: lane2, judgePoolIds: ["local-qwen/m1", "openai/cloudy"] });
  assert.equal(lane2.launches, 0, "policy-violating pool entry => zero launches");
  assert.match(r2.record.notes ?? "", /policy-denied ids/);

  const { dir: dir3, cfgBase: cfg3 } = await fixture("grammar");
  t.after(() => rm(dir3, { recursive: true, force: true }));
  const lane3 = stubLane(
    writer(dir3, (role, rel) => (role === "judge" ? "the artifact is good, i like it" : DEFAULT_CONTENT(role, rel))),
  );
  const r3 = await runChamber({ ...cfg3, lane: lane3 });
  assert.equal(r3.terminal, "NEEDS_ROUND", "unparseable verdict is fail-closed, never laundered");
  assert.equal(conclude(r3).conclusion, "NEEDS_HUMAN");
});

test("parseJudgeRound grammar: strict acceptance and refusal table", () => {
  assert.ok(parseJudgeRound(JUDGE_CONVERGED));
  const fence = String.fromCharCode(96, 96, 96);
  assert.ok(parseJudgeRound(fence + "json\n" + JUDGE_CONVERGED + "\n" + fence));
  assert.equal(parseJudgeRound(JSON.stringify({ ...JSON.parse(JUDGE_CONVERGED), convergence: "MAYBE" })), null);
  assert.equal(parseJudgeRound(JSON.stringify({ ...JSON.parse(JUDGE_CONVERGED), confidence: 2 })), null);
  assert.equal(
    parseJudgeRound(JSON.stringify({ convergence: "CONVERGED", conclusion: "REJECT", confidence: 0.5, reasons: [], must_fix: [], charges: [] })),
    null,
    "REJECT without reasons is unactionable",
  );
  assert.equal(parseJudgeRound("prose only"), null);
});
