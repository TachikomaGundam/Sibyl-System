// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// AGGREGATE stage (dispatch-review §4) — two jobs:
// 1. summarizeTaskOutput: context-sharding fan-in. Workers write their FULL
//    draft to the run-space dir (dispatcher's injected writeDraft callback);
//    only the truncated CONCLUSIONS summary travels downstream and into the
//    final report. Full drafts are NEVER inlined into prompts.
// 2. buildReport: produces the final SwarmReport with the unified verdict
//    vocabulary. A judge callback MAY override the derivation; without one the
//    verdict is derived: all done → APPROVE, any failed/suspended after caps
//    → REJECT, round budget consumed → EXHAUSTED.

import { SWARM_VERDICTS, type SwarmReport, type SwarmVerdict, type TaskStatus, isSwarmVerdict } from "./types.ts";

export const DEFAULT_SUMMARY_MAX_CHARS = 1200;

/** Keep summaries deterministic: pure truncation, no timing, no randomness. */
export function summarizeTaskOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[…truncated; full draft is at the file ref]`;
}

export type JudgeFn = (report: SwarmReport) => SwarmVerdict;

export type ReportInput = {
  /** Wave-cycles executed by the dispatcher (kept across resume). */
  rounds: number;
  /** True when the round budget was consumed with work still pending. */
  exhausted: boolean;
  /** Terminal per-task results, in schema task order. */
  tasks: { id: string; status: TaskStatus; sessionId?: string; summary?: string }[];
  /** File refs of the full drafts (run-space dir paths), schema task order. */
  artifacts: string[];
};

/** Derivation rule (dispatch-review §4 / plan success criteria). */
export function deriveVerdict(input: Pick<ReportInput, "exhausted" | "tasks">): SwarmVerdict {
  // EXHAUSTED requires work still undone — a stale flag must not mask convergence after resume (P5)
  if (input.exhausted && input.tasks.some((t) => t.status !== "done")) {
    return SWARM_VERDICTS.EXHAUSTED;
  }
  if (input.tasks.some((t) => t.status !== "done")) {
    return SWARM_VERDICTS.REJECT;
  }
  return SWARM_VERDICTS.APPROVE;
}

export function buildReport(input: ReportInput, judge?: JudgeFn): SwarmReport {
  const tasks = input.tasks.map((t) => ({
    id: t.id,
    status: t.status,
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    ...(t.summary !== undefined ? { summary: t.summary } : {}),
  }));
  const derived: SwarmReport = {
    verdict: deriveVerdict(input),
    rounds: input.rounds,
    tasks,
    artifacts: input.artifacts.slice(),
  };
  if (judge === undefined) {
    return derived;
  }
  // Judge criteria from PLAN-style wiring: the judge sees the full derived
  // report and may override the verdict; a throwing or non-vocabulary judge
  // output is a judge bug — fail closed to the derived verdict.
  let judged: SwarmVerdict | undefined;
  try {
    judged = judge(derived);
  } catch {
    judged = undefined;
  }
  return judged !== undefined && isSwarmVerdict(judged) ? { ...derived, verdict: judged } : derived;
}