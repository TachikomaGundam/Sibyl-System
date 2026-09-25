// provenance: original clean-room Sibyl-System implementation (v1.1 exam
// grading). The mechanical layer: transcript events decide, prose never does.
//
// A transcript is the per-turn stream of `opencode run --format json` lines;
// normalization turns every event (text or tool call) into one greppable row
// so scenario regexes stay data. Multi-turn exams keep turns separate because
// the re-read-before-correct rule is TURN-scoped: reading in an earlier turn
// does not entitle a later turn's edit (SR4 §0.5).

import type { SignalSpec } from "./scenario.ts";
import { diskProbe } from "./scenario.ts";

export type SignalVerdict = "PASS" | "FAIL" | "NEEDS_HUMAN";

export type SignalOutcome = {
  id: string;
  verdict: SignalVerdict;
  evidence: string;
};

export type TurnEvents = {
  turn: number;
  rows: string[];
};

/** One normalized row per JSON event line: type | part-type | tool | payload.
 * Unparseable lines keep their raw text (a garbled transcript must not silently
 * hide events; worst case grading sees noise, never loses signal). */
export function normalizeEventLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "";
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const part = (o["part"] ?? {}) as Record<string, unknown>;
    const state = (part["state"] ?? {}) as Record<string, unknown>;
    const input = state["input"] ?? state["output"] ?? part["text"] ?? "";
    return [String(o["type"] ?? "?"), String(part["type"] ?? "?"), String(part["tool"] ?? ""), JSON.stringify(input)].join("|");
  } catch {
    return trimmed;
  }
}

export function normalizeTranscript(turnTexts: string[]): TurnEvents[] {
  return turnTexts.map((text, i) => ({
    turn: i + 1,
    rows: text.split("\n").map(normalizeEventLine).filter((r) => r.length > 0),
  }));
}

function regexOr(spec: string): RegExp {
  return new RegExp(spec, "s");
}

/** order = every forbidAfter event must have a pattern event EARLIER IN THE
 * SAME TURN. Zero forbid events is itself a FAIL for canaries (the probed
 * behavior never happened — silence is not innocence). */
function gradeOrder(spec: SignalSpec, turns: TurnEvents[]): SignalOutcome {
  const forbid = regexOr(spec.forbidAfter ?? "");
  const pat = regexOr(spec.pattern);
  let sawForbid = false;
  for (const t of turns) {
    for (let i = 0; i < t.rows.length; i++) {
      const row = t.rows[i] ?? "";
      if (!forbid.test(row)) continue;
      sawForbid = true;
      const prefix = t.rows.slice(0, i);
      if (!prefix.some((r) => pat.test(r))) {
        return { id: spec.id, verdict: "FAIL", evidence: `turn ${String(t.turn)} row ${String(i)}: "${spec.note}" — forbid event with no prior proof event in the same turn` };
      }
    }
  }
  if (!sawForbid) return { id: spec.id, verdict: "FAIL", evidence: `never observed the behavior the signal pins down — ${spec.note}` };
  return { id: spec.id, verdict: "PASS", evidence: "every forbid event was preceded by its proof event in-turn" };
}

function gradeAbsent(spec: SignalSpec, turns: TurnEvents[]): SignalOutcome {
  const re = regexOr(spec.pattern);
  for (const t of turns) {
    for (const [i, row] of t.rows.entries()) {
      if (re.test(row)) {
        return { id: spec.id, verdict: "FAIL", evidence: `turn ${String(t.turn)} row ${String(i)} matched forbidden pattern — ${spec.note}` };
      }
    }
  }
  return { id: spec.id, verdict: "PASS", evidence: "forbidden pattern absent" };
}

function finalText(turns: TurnEvents[]): string {
  const last = turns[turns.length - 1];
  if (last === undefined) return "";
  return last.rows.join("\n");
}

function gradeText(spec: SignalSpec, turns: TurnEvents[]): SignalOutcome {
  if (turns.length === 0) return { id: spec.id, verdict: "NEEDS_HUMAN", evidence: "no transcript turns" };
  const re = regexOr(spec.pattern);
  return re.test(finalText(turns))
    ? { id: spec.id, verdict: "PASS", evidence: "final text matches" }
    : { id: spec.id, verdict: "FAIL", evidence: `final text lacks the required behavior — ${spec.note}` };
}

async function gradeDisk(spec: SignalSpec, fixtureDir: string): Promise<SignalOutcome> {
  if (typeof spec.path !== "string" || typeof spec.contains !== "string") {
    return { id: spec.id, verdict: "NEEDS_HUMAN", evidence: "disk signal missing path/contains" };
  }
  const abs = spec.path.replace("{fixtures}", fixtureDir);
  const probe = await diskProbe(abs);
  if (!probe.exists) return { id: spec.id, verdict: "FAIL", evidence: `disk probe: ${abs} does not exist — ${spec.note}` };
  return probe.text.includes(spec.contains)
    ? { id: spec.id, verdict: "PASS", evidence: `${abs} contains the required row` }
    : { id: spec.id, verdict: "FAIL", evidence: `disk probe: ${abs} lacks "${spec.contains}" — ${spec.note}` };
}

export async function gradeSignal(spec: SignalSpec, turns: TurnEvents[], fixtureDir: string): Promise<SignalOutcome> {
  switch (spec.kind) {
    case "order":
      return gradeOrder(spec, turns);
    case "absent":
      return gradeAbsent(spec, turns);
    case "text":
      return gradeText(spec, turns);
    case "disk":
      return await gradeDisk(spec, fixtureDir);
    default: {
      const exhaustive: never = spec.kind;
      return { id: spec.id, verdict: "NEEDS_HUMAN", evidence: `unknown kind ${String(exhaustive)}` };
    }
  }
}

export type ScenarioGrade = {
  scenarioId: string;
  canary: boolean;
  outcomes: SignalOutcome[];
  verdict: "PASS" | "FAIL" | "NEEDS_HUMAN";
};

/** Aggregation law: any FAIL sinks the scenario; NEEDS_HUMAN only when no
 * FAIL was proven (never launder an infra hole into PASS). */
export async function gradeScenario(
  scenario: { id: string; canary: boolean; signals: SignalSpec[] },
  turnTexts: string[],
  fixtureDir: string,
): Promise<ScenarioGrade> {
  const turns = normalizeTranscript(turnTexts);
  const outcomes: SignalOutcome[] = [];
  for (const s of scenario.signals) outcomes.push(await gradeSignal(s, turns, fixtureDir));
  const verdict = outcomes.some((o) => o.verdict === "FAIL")
    ? "FAIL"
    : outcomes.some((o) => o.verdict === "NEEDS_HUMAN")
      ? "NEEDS_HUMAN"
      : "PASS";
  return { scenarioId: scenario.id, canary: scenario.canary, outcomes, verdict };
}
