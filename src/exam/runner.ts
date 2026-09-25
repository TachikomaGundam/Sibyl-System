// provenance: original clean-room Sibyl-System implementation (v1.1 exam
// runner). One scenario = fixtures on disk -> quarantined candidate -> verbatim
// user turns (in-session continuation, in-framework) -> mechanical grading ->
// canary veto. The candidate never grades itself; transcripts + disk decide.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScenarioSpec } from "./scenario.ts";
import { expandFixtures } from "./scenario.ts";
import { gradeScenario, type ScenarioGrade } from "./signals.ts";
import type { LaunchFacts } from "../chamber/protocol.ts";

export type DriverTurn = {
  facts: LaunchFacts;
  transcript: string;
  sessionId: string | null;
};

/** The candidate-session seam: e2e wires the isolated lane (start = fresh
 * `opencode run`, continue = `opencode run --session <id>` — probe-verified
 * in-framework continuation); unit tests drive synthetic transcripts. */
export type CandidateDriver = {
  start(prompt: string): Promise<DriverTurn>;
  continueTurn(sessionId: string, message: string): Promise<DriverTurn>;
};

export type ExamResult = {
  scenarioId: string;
  canary: boolean;
  grade: ScenarioGrade;
  veto: boolean;
  infraGaps: string[];
  fixtureDir: string;
  transcriptDir: string;
};

export async function runExamScenario(scenario: ScenarioSpec, runDir: string, driver: CandidateDriver): Promise<ExamResult> {
  const fixtureDir = join(runDir, "fixtures");
  const transcriptDir = join(runDir, "candidate");
  await mkdir(transcriptDir, { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  for (const [rel, content] of Object.entries(scenario.fixtures)) {
    const abs = join(fixtureDir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, expandFixtures(content, fixtureDir), "utf8");
  }
  const infraGaps: string[] = [];
  const turns: string[] = [];

  const first = await driver.start(expandFixtures(scenario.prompt, fixtureDir));
  turns.push(first.transcript);
  await writeFile(join(transcriptDir, "turn-1.jsonl"), first.transcript, "utf8");
  if (!first.facts.ok) infraGaps.push(`candidate turn 1 failed (rc=${String(first.facts.rc)} timedOut=${String(first.facts.timedOut)}) — one retry is the caller's policy, the runner does not spam`);

  let sessionId = first.sessionId;
  for (const [i, turn] of scenario.turns.entries()) {
    if (sessionId === null) {
      infraGaps.push(`turn ${String(i + 2)} skipped: no session id from earlier transcript`);
      turns.push("");
      continue;
    }
    const next = await driver.continueTurn(sessionId, expandFixtures(turn, fixtureDir));
    turns.push(next.transcript);
    await writeFile(join(transcriptDir, `turn-${String(i + 2)}.jsonl`), next.transcript, "utf8");
    if (!next.facts.ok) infraGaps.push(`candidate turn ${String(i + 2)} failed (rc=${String(next.facts.rc)})`);
    if (next.sessionId !== null) sessionId = next.sessionId;
  }

  const grade = await gradeScenario(scenario, turns, fixtureDir);
  const veto = scenario.canary && grade.verdict === "FAIL";
  return {
    scenarioId: scenario.id,
    canary: scenario.canary,
    grade,
    veto,
    infraGaps,
    fixtureDir: fixtureDir,
    transcriptDir,
  };
}

/** Exam half of the one voice: PASS->APPROVE, FAIL->REJECT (canary veto
 * stated), NEEDS_HUMAN stays honest about which signals were unresolvable. */
export function examConclusion(results: ExamResult[]): { conclusion: "APPROVE" | "REJECT" | "NEEDS_HUMAN"; rationale: string[]; mustFix: string[] } {
  const rationale: string[] = [];
  const mustFix: string[] = [];
  let anyFail = false;
  let anyHuman = false;
  for (const r of results) {
    const line = `${r.scenarioId}: ${r.grade.verdict}${r.veto ? " CANARY-VETO" : ""}`;
    rationale.push(line);
    for (const o of r.grade.outcomes) {
      if (o.verdict === "FAIL") mustFix.push(`${r.scenarioId}/${o.id}: ${o.evidence}`);
      if (o.verdict === "NEEDS_HUMAN") mustFix.push(`${r.scenarioId}/${o.id}: unresolvable — ${o.evidence}`);
    }
    for (const g of r.infraGaps) mustFix.push(`${r.scenarioId}/infra: ${g}`);
    if (r.grade.verdict === "FAIL") anyFail = true;
    if (r.grade.verdict === "NEEDS_HUMAN" || r.infraGaps.length > 0) anyHuman = true;
  }
  if (anyFail) return { conclusion: "REJECT", rationale, mustFix };
  if (anyHuman) return { conclusion: "NEEDS_HUMAN", rationale, mustFix };
  return { conclusion: "APPROVE", rationale, mustFix };
}
