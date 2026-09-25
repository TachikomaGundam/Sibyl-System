// provenance: original clean-room Sibyl-System implementation (v1.1 chamber),
// no external code copied. 民主 half of 民主集中制: the internal, high-
// intensity clash over broadly-gathered evidence — blind drafts, cross-
// critique, an independently-drawn judge, bounded rounds, explicit terminals.
//
// Isolation property inherited from the adversarial-swarm protocol: no member
// sees another member's RAW output; artifacts on disk are the only medium,
// published deliberately at the cross-critique step. Sessions are phases, not
// personas — one fresh launch per phase keeps collusion surfaces minimal.
//
// All process/IO goes through the injected Lane (unit tests script it; the
// real lane is src/lane/isolated.ts). The protocol is the only writer of
// DISAGREEMENT-LOG.md (mechanical appends from judge output) and assembles
// the run record. Seat/draw/pool-policy failures close the run with ZERO
// launches (E2/E4 are start-line laws).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { drawJudge, policyAllows, resolveSeat, type SeatPolicy, type SeatPool } from "../lane/seating.ts";
import { extractVerdictJson } from "../verdict/index.ts";
import type { ChamberRecord, RosterRef, TerminalState } from "../state/chamber.ts";
import { finalizeRecord, sha256Text } from "../state/chamber.ts";

export type ChamberRole = "evidence" | "pro" | "con" | "judge";

export type LaunchFacts = {
  ok: boolean;
  rc: number | null;
  signal: string | null;
  timedOut: boolean;
};

export type Lane = {
  launch(req: { role: string; title: string; modelId: string; message: string; launchId: string }): Promise<LaunchFacts>;
  kill(role: string): Promise<{ ok: boolean; reason?: string }>;
};

export type ChamberConfig = {
  runId: string;
  runDir: string;
  goal: string;
  targetPath: string;
  ledgerPath: string;
  seed: string;
  maxRounds: number;
  pool: SeatPool;
  policy: SeatPolicy;
  slots: Record<ChamberRole, string>;
  judgePoolIds: string[];
  lane: Lane;
  /** A2 fault injection: SIGKILL this role's group after N ms of its phase. */
  killInjection?: { role: ChamberRole; afterMs: number };
  now?: () => Date;
};

export type JudgeRound = {
  convergence: "CONVERGED" | "NEEDS_ROUND";
  conclusion: "APPROVE" | "REJECT" | "NEEDS_HUMAN";
  confidence: number;
  reasons: string[];
  must_fix: string[];
  charges: string[];
};

export type ChamberResult = {
  record: ChamberRecord;
  judge: JudgeRound | null;
  terminal: TerminalState;
  gaps: string[];
};

export const CHAMBER_ROLES: readonly ChamberRole[] = ["evidence", "pro", "con", "judge"];

export function isChamberRole(v: string): v is ChamberRole {
  return (CHAMBER_ROLES as readonly string[]).includes(v);
}

export function artifactRel(role: ChamberRole, round: number, kind: "draft" | "rebuttal" | "verdict"): string {
  if (role === "evidence") return "evidence/evidence.jsonl";
  if (role === "judge") return `judge/round-${String(round)}.json`;
  const suffix = kind === "rebuttal" ? `-rebuttal-${String(round)}` : `-${String(round)}`;
  return `${role}/round${suffix}.md`;
}

/* ── strict judge verdict parse (fail-closed null, reuses extraction) ── */

export function parseJudgeRound(text: string): JudgeRound | null {
  const json = extractVerdictJson(text);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const conv = o["convergence"];
  const concl = o["conclusion"];
  if (conv !== "CONVERGED" && conv !== "NEEDS_ROUND") return null;
  if (concl !== "APPROVE" && concl !== "REJECT" && concl !== "NEEDS_HUMAN") return null;
  const confidence = o["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const arrs = [o["reasons"], o["must_fix"], o["charges"]];
  if (!arrs.every((v) => Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
  const reasons = o["reasons"] as string[];
  if (concl !== "APPROVE" && reasons.length === 0) return null;
  return {
    convergence: conv,
    conclusion: concl,
    confidence,
    reasons,
    must_fix: o["must_fix"] as string[],
    charges: o["charges"] as string[],
  };
}

/* ── role prompts (each names ONLY what that phase may see) ─────────── */

const CONTRACT = (writeTo: string, sections: string) =>
  `OUTPUT CONTRACT: as you work, WRITE your result incrementally to ${writeTo} (create parent dirs as needed). ` +
  `Required structure: ${sections}. The file on disk is the only receipt that counts; keep the chat reply short. ` +
  `Write ONLY inside your run directory.`;

function evidencePrompt(cfg: ChamberConfig, abs: string): string {
  return (
    `You are the EVIDENCE GATHERER of a Sibyl review chamber. Goal: "${cfg.goal}". ` +
    `Artifact under review: ${cfg.targetPath}. Enumerate evidence sources BROADLY first ` +
    `(list directories, then sample candidates: the target, adjacent docs/notes, logs, prior reviews). ` +
    `Breadth over depth; no deep analysis. Append one JSON object per line to ${abs}: ` +
    `{"probe":"<command or path read>","found":"<path>","class":"<doc|log|ledger|transcript|other>","note":"<one line>"}. ` +
    CONTRACT(abs, "one JSON object per line")
  );
}

function proPrompt(cfg: ChamberConfig, round: number, abs: string, charges: string[]): string {
  const chargeBlock = charges.length > 0 ? ` Prior open charges you must answer: ${JSON.stringify(charges)}.` : "";
  return (
    `You are PRO (round ${String(round)}) in a Sibyl adversarial chamber. Goal: "${cfg.goal}". ` +
    `Read ${cfg.targetPath} and the evidence ledger ${join(cfg.runDir, "evidence/evidence.jsonl")}, ` +
    `then argue for the strongest DEFENSIBLE version of the artifact: real merits, each claim citing ledger rows/paths, no spin.` +
    chargeBlock +
    " " +
    CONTRACT(abs, "## Case (numbered claims C1..Cn) and ## Evidence (claim -> cited paths)")
  );
}

function conPrompt(cfg: ChamberConfig, round: number, abs: string, charges: string[]): string {
  const chargeBlock = charges.length > 0 ? ` Previously contested — sharpen or drop: ${JSON.stringify(charges)}.` : "";
  return (
    `You are CON (round ${String(round)}) in a Sibyl adversarial chamber. Goal: "${cfg.goal}". ` +
    `Read ${cfg.targetPath} and the evidence ledger ${join(cfg.runDir, "evidence/evidence.jsonl")}, ` +
    `then attack the artifact: REAL defects only (correctness, missing evidence, unactionable claims), every charge citing a path or quote.` +
    chargeBlock +
    " " +
    CONTRACT(abs, "## Charges (numbered N1..Nn, each with cited evidence)")
  );
}

function rebuttalPrompt(cfg: ChamberConfig, role: "pro" | "con", round: number, otherAbs: string, abs: string): string {
  return (
    `You are ${role.toUpperCase()} in cross-critique (round ${String(round)}). Read your opponent's artifact at ${otherAbs} ` +
    `plus the evidence ledger under ${join(cfg.runDir, "evidence")} (you may re-probe primary sources). ` +
    `Respond point by point: CONCEDE what is right, REBUT what is wrong, replies keyed to the opponent's numbering. ` +
    `Never edit the opponent's file; write only your own new file. ` +
    CONTRACT(abs, "## Replies (K1..Kn keyed to opponent numbering) and ## Still Open")
  );
}

function judgePrompt(cfg: ChamberConfig, round: number, paths: string[], abs: string): string {
  return (
    `You are the INDEPENDENT JUDGE (round ${String(round)}) of a Sibyl chamber. You wrote nothing here. ` +
    `FIRST ACTION (no analysis before it): write a valid interim JSON to ${abs} — ` +
    `{"convergence":"NEEDS_ROUND","conclusion":"NEEDS_HUMAN","confidence":0,"reasons":["interim - judging"],"must_fix":[],"charges":[]} — ` +
    `then read the materials and OVERWRITE it with your final verdict as your last action. ` +
    `Read ALL of: ${paths.join(" ; ")} and the original target ${cfg.targetPath}. ` +
    `Re-probe AT MOST the three most load-bearing citations (open the cited file; a citation to a non-existent ` +
    `path is an automatic charge) — time-box yourself, breadth of verification below 3 is enough. ` +
    `Decide if the debate has CONVERGED (no material open charges) and the single review conclusion. ` +
    `The file must end holding EXACTLY ONE JSON object: ` +
    `{"convergence":"CONVERGED"|"NEEDS_ROUND","conclusion":"APPROVE"|"REJECT"|"NEEDS_HUMAN","confidence":<0..1>,` +
    `"reasons":[...],"must_fix":[...],"charges":[...open charges; empty when CONVERGED]}. ` +
    `Also print the same JSON in your reply. Partial or non-JSON output = failure.`
  );
}

/* ── the round engine ────────────────────────────────────────────────── */

type Receipt = { rel: string; facts: LaunchFacts };

async function fileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

class Protocol {
  #cfg: ChamberConfig;
  #record: ChamberRecord;
  #gaps: string[] = [];
  #launchCount = 0;
  #killArmed = false;

  constructor(cfg: ChamberConfig, record: ChamberRecord) {
    this.#cfg = cfg;
    this.#record = record;
  }

  get launchCount(): number {
    return this.#launchCount;
  }

  #abs(rel: string): string {
    return join(this.#cfg.runDir, rel);
  }

  addGap(reason: string): void {
    this.#gaps.push(reason);
  }

  async close(terminal: TerminalState, judge: JudgeRound | null): Promise<ChamberResult> {
    const notes = [this.#record.notes ?? "", ...this.#gaps].filter((s) => s.length > 0).join(" | ");
    const record: ChamberRecord = { ...this.#record, terminal };
    if (notes.length > 0) record.notes = notes;
    const res = await finalizeRecord(record, { writeLedger: { path: this.#cfg.ledgerPath }, checksums: true });
    if (res.ok) return { record: res.record, judge, terminal, gaps: this.#gaps };
    this.#gaps.push(...res.drift);
    const retryRecord: ChamberRecord = { ...record, notes: [record.notes ?? "", `drift: ${res.drift.join("; ")}`].join(" | ") };
    const again = await finalizeRecord(retryRecord, { writeLedger: { path: this.#cfg.ledgerPath }, checksums: true });
    if (!again.ok) throw new Error(`record refused twice: ${again.drift.join("; ")}`);
    return { record: again.record, judge, terminal, gaps: this.#gaps };
  }

  async #phase(
    role: ChamberRole,
    round: number,
    kind: "draft" | "rebuttal" | "verdict",
    prompt: string,
    modelId: string,
  ): Promise<Receipt | null> {
    const cfg = this.#cfg;
    const rel = artifactRel(role, round, kind);
    const title = `sibyl-${cfg.runId}-${role}-r${String(round)}-${kind}`;
    this.#launchCount += 1;
    if (cfg.killInjection !== undefined && cfg.killInjection.role === role && !this.#killArmed) {
      this.#killArmed = true;
      const inject = cfg.killInjection;
      setTimeout(() => {
        void cfg.lane.kill(inject.role);
      }, inject.afterMs);
    }
    const facts = await cfg.lane.launch({ role, title, modelId, message: prompt, launchId: `r${String(round)}-${kind}` });
    const text = await fileOrEmpty(this.#abs(rel));
    if (text.trim().length > 0) {
      this.#record.artifacts.push({
        role,
        round,
        phase: kind,
        relPath: rel,
        sha256: sha256Text(text),
        bytes: Buffer.byteLength(text, "utf8"),
        presentAt: (cfg.now?.() ?? new Date()).toISOString(),
        rc: facts.rc,
        signal: facts.signal,
        timedOut: facts.timedOut,
      });
    }
    if (!facts.ok) {
      const why = facts.timedOut ? "timeout" : `rc=${String(facts.rc)} signal=${String(facts.signal)}`;
      this.#gaps.push(`${role} round ${String(round)} (${kind}): ${why}; artifact ${text.trim().length > 0 ? "PARTIAL kept" : "absent"}`);
      return facts.timedOut ? { rel, facts } : null;
    }
    if (text.trim().length === 0) {
      this.#gaps.push(`${role} round ${String(round)} (${kind}): alive but no artifact on disk (L5 violation)`);
      return null;
    }
    return { rel, facts };
  }

  #model(role: ChamberRole): string {
    return this.#record.roster.find((r) => r.role === role)?.modelId ?? "";
  }

  #dead(r: Receipt | null): boolean {
    return r === null || r.facts.timedOut;
  }

  #terminalFor(roundLabel: string, receipts: (Receipt | null)[]): TerminalState {
    if (receipts.some((r) => r !== null && r.facts.timedOut)) return "TIMEOUT";
    this.#gaps.push(`${roundLabel}: member artifact missing or process died (L6 MEMBER_LOST)`);
    return "MEMBER_LOST";
  }

  async run(): Promise<ChamberResult> {
    const cfg = this.#cfg;
    if (this.#record.roster.some((r) => r.policyCheck === "deny")) {
      const denied = this.#record.roster
        .filter((r) => r.policyCheck === "deny")
        .map((r) => `${r.role}:${r.denyReason ?? "denied"}`)
        .join(" | ");
      this.#gaps.push(`seats denied before any launch (E2/E4): ${denied}`);
      return await this.close("NEEDS_ROUND", null);
    }

    const evRel = artifactRel("evidence", 0, "draft");
    const ev = await this.#phase("evidence", 0, "draft", evidencePrompt(cfg, this.#abs(evRel)), this.#model("evidence"));
    if (ev !== null) {
      this.#record.evidenceRows = (await fileOrEmpty(this.#abs(evRel))).split("\n").filter((l) => l.trim().length > 0).length;
    }

    let judge: JudgeRound | null = null;
    let charges: string[] = [];

    if (this.#dead(ev)) return await this.close(this.#terminalFor("evidence", [ev ?? null]), null);

    for (let round = 1; round <= cfg.maxRounds; round++) {
      this.#record.rounds = round;
      const proRel = artifactRel("pro", round, "draft");
      const conRel = artifactRel("con", round, "draft");
      const drafts = await Promise.all([
        this.#phase("pro", round, "draft", proPrompt(cfg, round, this.#abs(proRel), charges), this.#model("pro")),
        this.#phase("con", round, "draft", conPrompt(cfg, round, this.#abs(conRel), charges), this.#model("con")),
      ]);
      if (drafts.some((d) => this.#dead(d))) {
        return await this.close(this.#terminalFor(`round ${String(round)} drafts`, drafts), judge);
      }

      const rebs = await Promise.all([
        this.#phase("pro", round, "rebuttal", rebuttalPrompt(cfg, "pro", round, this.#abs(conRel), this.#abs(artifactRel("pro", round, "rebuttal"))), this.#model("pro")),
        this.#phase("con", round, "rebuttal", rebuttalPrompt(cfg, "con", round, this.#abs(proRel), this.#abs(artifactRel("con", round, "rebuttal"))), this.#model("con")),
      ]);
      if (rebs.some((d) => this.#dead(d))) {
        return await this.close(this.#terminalFor(`round ${String(round)} cross-critique`, rebs), judge);
      }

      const judgeRel = artifactRel("judge", round, "verdict");
      const judgeAbs = this.#abs(judgeRel);
      // mechanical interim seed: at every instant the judge file is parseable
      // (NEEDS_HUMAN/NEEDS_ROUND) — a death mid-judgment yields honest partials
      // instead of a missing receipt. The judge is told to OVERWRITE it.
      if ((await fileOrEmpty(judgeAbs)).trim().length === 0) {
        await writeFile(
          judgeAbs,
          JSON.stringify({ convergence: "NEEDS_ROUND", conclusion: "NEEDS_HUMAN", confidence: 0, reasons: ["interim - judging"], must_fix: [], charges: ["judge has not concluded"] }),
          "utf8",
        );
      }
      const seen = [evRel, proRel, conRel, artifactRel("pro", round, "rebuttal"), artifactRel("con", round, "rebuttal")].map((r) => this.#abs(r));
      const jr = await this.#phase("judge", round, "verdict", judgePrompt(cfg, round, seen, judgeAbs), this.#model("judge"));
      if (this.#dead(jr)) {
        return await this.close(this.#terminalFor(`round ${String(round)} judge`, [jr]), judge);
      }
      const parsed = parseJudgeRound(await fileOrEmpty(this.#abs(judgeRel)));
      if (parsed === null) {
        this.#gaps.push(`judge round ${String(round)}: verdict artifact is not the strict JSON grammar (fail-closed)`);
        return await this.close("NEEDS_ROUND", null);
      }
      judge = parsed;
      charges = parsed.charges;
      await this.#logDisagreement(round, parsed);
      if (parsed.convergence === "CONVERGED") {
        if (parsed.conclusion === "NEEDS_HUMAN") this.#gaps.push(`judge converged with NEEDS_HUMAN: ${parsed.reasons.join("; ")}`);
        return await this.close("CONVERGED", judge);
      }
    }
    this.#gaps.push(`rounds exhausted (${String(cfg.maxRounds)}) with ${String(charges.length)} open charges — human decides whether to continue`);
    return await this.close("NEEDS_ROUND", judge);
  }

  async #logDisagreement(round: number, judge: JudgeRound): Promise<void> {
    const logPath = join(this.#cfg.runDir, "DISAGREEMENT-LOG.md");
    const prior = await fileOrEmpty(logPath);
    const entry =
      `\n## round ${String(round)} — ${judge.convergence} / ${judge.conclusion} (confidence ${String(judge.confidence)})\n` +
      `- open charges: ${judge.charges.length === 0 ? "(none)" : JSON.stringify(judge.charges)}\n` +
      `- judge reasons: ${JSON.stringify(judge.reasons)}\n`;
    await writeFile(logPath, prior + entry, "utf8");
  }
}

/**
 * Resolve every seat through policy BEFORE anything launches; validate the
 * judge pool against policy; draw the judge (E2, commit recorded in the START
 * face). Any start-line failure closes with ZERO lane launches.
 */
export async function runChamber(
  cfg: ChamberConfig,
  onRecord?: (record: ChamberRecord) => void,
): Promise<ChamberResult> {
  await mkdir(join(cfg.runDir, "pids"), { recursive: true });
  await mkdir(join(cfg.runDir, "evidence"), { recursive: true });
  for (const role of CHAMBER_ROLES) await mkdir(join(cfg.runDir, role), { recursive: true });

  const roster: RosterRef[] = CHAMBER_ROLES.map((role) => {
    const d = resolveSeat(role, cfg.slots[role], cfg.pool, cfg.policy);
    return d.ok
      ? { role, slot: d.slot, modelId: d.modelId, policyCheck: "allow" as const }
      : { role, slot: cfg.slots[role], modelId: "", policyCheck: "deny" as const, denyReason: d.deny };
  });

  const poolViolations = cfg.judgePoolIds.filter((id) => !policyAllows(id, cfg.policy));
  const draw = poolViolations.length === 0 ? drawJudge(cfg.judgePoolIds, cfg.seed, cfg.runId) : { ok: false as const, deny: `judge pool contains policy-denied ids: ${poolViolations.join(", ")}` };

  const judgeEntry = roster.find((r) => r.role === "judge");
  if (draw.ok && judgeEntry !== undefined && judgeEntry.policyCheck === "allow") {
    judgeEntry.modelId = draw.draw.modelId;
  } else if (!draw.ok && judgeEntry !== undefined) {
    judgeEntry.policyCheck = "deny";
    judgeEntry.modelId = "";
    judgeEntry.denyReason = draw.deny;
  }

  const drawCommit = draw.ok ? draw.draw.drawCommit : "";
  const record = await startRecord(cfg, roster, drawCommit);
  const proto = new Protocol(cfg, record);
  onRecord?.(record);
  return await proto.run();
}

async function startRecord(cfg: ChamberConfig, roster: RosterRef[], drawCommit: string): Promise<ChamberRecord> {
  const nowIso = (cfg.now?.() ?? new Date()).toISOString();
  const base: ChamberRecord = {
    schema: 1,
    runId: cfg.runId,
    serial: 0,
    profile: "review",
    goal: cfg.goal,
    target: cfg.targetPath,
    runDir: cfg.runDir,
    createdAt: nowIso,
    updatedAt: nowIso,
    terminal: null,
    roster,
    judgePool: [...cfg.judgePoolIds],
    seed: cfg.seed,
    drawCommit,
    judgeModelId: roster.find((r) => r.role === "judge")?.modelId ?? "",
    rounds: 0,
    artifacts: [],
    evidenceRows: 0,
  };
  const first = await finalizeRecord(base);
  if (!first.ok) throw new Error(`START record refused: ${first.drift.join("; ")}`);
  return first.record;
}
