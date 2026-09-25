// provenance: original clean-room Sibyl-System implementation (v1.1 chamber),
// no external code copied. 集中 half of 民主集中制: whatever happened inside
// (however many voices clashed), the chamber speaks with exactly ONE voice —
// one conclusion, cited by path+hash to the sealed internal record, never a
// dump of the debate. Fail-closed: gaps in the internals force NEEDS_HUMAN;
// there is no default APPROVE anywhere in this module.

import type { ChamberResult } from "./protocol.ts";
import type { ChamberRecord, Conclusion, TerminalState } from "../state/chamber.ts";
import { spotcheckCommand } from "../state/chamber.ts";

/** Honest-ceiling label (SR3): single-uid box ⇒ loud, not impossible. */
export const PERFORMANCE_ONLY_IN_LOOP = "PERFORMANCE-ONLY-IN-LOOP" as const;

export type SibylVoice = {
  label: "SIBYL-ONE-VOICE";
  honesty: typeof PERFORMANCE_ONLY_IN_LOOP;
  conclusion: Conclusion;
  confidence: number;
  rationale: string[];
  must_fix: string[];
  open_charges: number;
  dissent_sealed_in: string[];
  terminal: TerminalState;
  run_id: string;
  serial: number;
  spotcheck: string;
};

const MAX_RATIONALE = 6;

/** Map (terminal, judge, gaps) to the single external conclusion. */
export function conclude(result: ChamberResult): { conclusion: Conclusion; confidence: number } {
  const { terminal, judge, gaps } = result;
  if (gaps.length > 0 && (terminal === "MEMBER_LOST" || terminal === "TIMEOUT")) {
    return { conclusion: "NEEDS_HUMAN", confidence: 0 };
  }
  if (terminal === "CONVERGED" && judge !== null) {
    const base = judge.conclusion;
    const conclusion: Conclusion = base === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : gaps.length > 0 ? "NEEDS_HUMAN" : base;
    return { conclusion, confidence: conclusion === "NEEDS_HUMAN" ? Math.min(judge.confidence, 0.5) : judge.confidence };
  }
  // NEEDS_ROUND (exhausted or unparseable) — the debate has not earned a verdict
  if (judge !== null && judge.convergence === "NEEDS_ROUND") {
    return { conclusion: "NEEDS_HUMAN", confidence: Math.min(judge.confidence, 0.5) };
  }
  return { conclusion: "NEEDS_HUMAN", confidence: 0 };
}

export function buildVoice(result: ChamberResult): SibylVoice {
  const { record, judge, terminal, gaps } = result;
  const { conclusion, confidence } = conclude(result);
  const rationale = judge !== null && conclusion !== "NEEDS_HUMAN"
    ? judge.reasons.slice(0, MAX_RATIONALE)
    : (judge?.reasons ?? []).slice(0, MAX_RATIONALE).concat(gaps).slice(0, MAX_RATIONALE);
  const sealed: string[] = [
    "DISAGREEMENT-LOG.md",
    ...new Set(record.artifacts.map((a) => a.relPath)),
  ];
  return {
    label: "SIBYL-ONE-VOICE",
    honesty: PERFORMANCE_ONLY_IN_LOOP,
    conclusion,
    confidence: conclusion === "NEEDS_HUMAN" ? Number(confidence.toFixed(2)) : confidence,
    rationale,
    must_fix: judge?.must_fix ?? [],
    open_charges: judge?.charges.length ?? 0,
    dissent_sealed_in: sealed,
    terminal,
    run_id: record.runId,
    serial: record.serial,
    spotcheck: spotcheckCommand(record.runDir),
  };
}

/** THE single-voice rendering — the only text the outside world gets. */
export function renderVoice(voice: SibylVoice): string {
  const lines = [
    `SIBYL — ONE CONCLUSION, ONE VOICE  [${voice.label}]`,
    `conclusion: ${voice.conclusion}  confidence: ${String(voice.confidence)}  terminal: ${voice.terminal}`,
    `run: ${voice.run_id} (serial ${String(voice.serial)})  open charges: ${String(voice.open_charges)}`,
    `honesty: ${voice.honesty} (until C-09/C-14 containment rulings — see docs/isolation-laws.md)`,
    "rationale:",
    ...voice.rationale.map((r, i) => `  ${String(i + 1)}. ${r}`),
  ];
  if (voice.must_fix.length > 0) {
    lines.push("must_fix:");
    lines.push(...voice.must_fix.map((m) => `  - ${m}`));
  }
  lines.push(`internal debate sealed in run dir: ${voice.dissent_sealed_in.length} artifacts + DISAGREEMENT-LOG.md (hashes in CHECKSUMS.txt)`);
  lines.push(`verify every recorded byte: ${voice.spotcheck}`);
  return lines.join("\n");
}

/** Machine guard used by tools/tests: exactly one conclusion token appears. */
export function singleVoiceCheck(rendered: string, record: ChamberRecord): { ok: true } | { ok: false; reason: string } {
  const tokens: Conclusion[] = ["APPROVE", "REJECT", "NEEDS_HUMAN"];
  const hits = tokens.filter((t) => new RegExp(`conclusion: ${t}\\b`).test(rendered));
  if (hits.length !== 1) return { ok: false, reason: `expected exactly one conclusion line, found ${String(hits.length)}` };
  if (rendered.includes("## Charges") || rendered.includes("## Case")) {
    return { ok: false, reason: "internal clash sections leaked into the external voice" };
  }
  if (!rendered.includes(record.runId)) return { ok: false, reason: "voice does not cite its run id" };
  return { ok: true };
}
