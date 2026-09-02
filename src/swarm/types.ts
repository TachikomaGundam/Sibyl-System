// provenance: original clean-room Sibyl-System implementation (plan task 7 — swarm
// dispatch layer, G2-FINAL per docs/dispatch-review.md §4), no swarm code copied.

import type { EngineClient } from "../engine/index.ts";
//
// Shared vocabulary of the PLAN → MINT → DISPATCH → AGGREGATE pipeline.
// All types here are structural (persona/model/pool arrive as plain parameters:
// src/personas.ts and src/options.ts are owned by a concurrent task).
//
// SWARM_VERDICTS is the SINGLE source of truth for the unified verdict
// vocabulary (dispatch-review §3/§4: fixes the CONVERGED/NEEDS_ROUND vs
// EXHAUSTED_ROUNDS split of the legacy layer). Council verdicts (APPROVE|REJECT)
// map IN to this vocabulary; EXHAUSTED means the round budget was consumed
// without convergence. erasableSyntaxOnly forbids enums — a `as const` object
// is the canonical form.

export const SWARM_VERDICTS = {
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  EXHAUSTED: "EXHAUSTED",
} as const;

export type SwarmVerdict = (typeof SWARM_VERDICTS)[keyof typeof SWARM_VERDICTS];

export function isSwarmVerdict(v: unknown): v is SwarmVerdict {
  return v === SWARM_VERDICTS.APPROVE || v === SWARM_VERDICTS.REJECT || v === SWARM_VERDICTS.EXHAUSTED;
}

/** Structural persona twin — satisfies engine RunPersonaOptions.persona. */
export type PersonaLike = {
  agent?: string;
  system?: string;
  disallowedTools?: string[];
};

/** Model slot — satisfies engine RunPersonaOptions.model. */
export type ModelSlot = {
  providerID: string;
  modelID: string;
};

/** Named model pool (kimi-code `[secondary_model]` analog); resolved at MINT. */
export type ModelPool = Record<string, ModelSlot>;

// --- PLAN stage -------------------------------------------------------------

export type WorkflowTask = {
  id: string;
  title: string;
  instructions: string;
  /** Task ids that must complete (status done) before this one starts. */
  dependsOn: string[];
};

export type WorkflowSchema = {
  tasks: WorkflowTask[];
  /** Suggested parallel fan-out width; integer >= 1. */
  concurrency: number;
  notes?: string;
};

export type PlanResult =
  | { ok: true; schema: WorkflowSchema }
  | { ok: false; stage: "plan"; error: string };

// --- MINT stage -------------------------------------------------------------

export type WorkerSpec = {
  /** Deterministic, collision-free worker id (`worker-<index>-<slug>`) . */
  workerId: string;
  /** The schema task this worker owns. */
  taskId: string;
  persona: PersonaLike;
  model: ModelSlot;
  /** Per-worker round budget (wave-cycles) stamped by MINT. */
  roundBudget: number;
  timeoutMs: number;
};

export type Roster = {
  schema: WorkflowSchema;
  workers: WorkerSpec[];
};

export type MintResult =
  | { ok: true; roster: Roster }
  | { ok: false; stage: "mint"; error: string };

// --- DISPATCH / AGGREGATE stages ---------------------------------------------

/** Terminal task status used in reports (suspended = retryable via resume). */
export type TaskStatus = "done" | "failed" | "suspended";

export type SwarmTaskResult = {
  id: string;
  status: TaskStatus;
  /** Present when a child session was created for the last attempt. */
  sessionId?: string;
  /** Present when the task produced worker output (done) — conclusions only. */
  summary?: string;
};

/** Final pipeline output (AGGREGATE stage). */
export type SwarmReport = {
  verdict: SwarmVerdict;
  /** Wave-cycles executed (kept across resume). */
  rounds: number;
  /** Per-task terminal results, schema task order. */
  tasks: SwarmTaskResult[];
  /** File refs (run-space dir paths) of the full drafts, schema task order. */
  artifacts: string[];
};

// --- dispatch types (shared with the driver; state is JSON-friendly) ----------

/** Injectable time source — tests swap in a fake that records delays. */
export type Clock = { sleep(ms: number): Promise<void> };

/** Writes a worker's FULL draft into the run-space dir; returns its ref path. */
export type WriteDraftFn = (args: { taskId: string; workerId: string; text: string }) => string | Promise<string>;

export type DispatchOptions = {
  client: EngineClient;
  directory: string;
  /** How many tasks may run in parallel per wave. */
  concurrencyK: number;
  /** Launch-spacing within a wave (ms); tests inject a fake clock. */
  staggerMs: number;
  writeDraft: WriteDraftFn;
  /** Same-worker retry cap (default 2) for non-rate-limit failures. */
  maxAttempts?: number;
  /** Sleep between attempts of the same task. */
  retryDelayMs?: number;
  /** Fan-in truncation width for downstream conclusions. */
  summaryMaxChars?: number;
  /** Round budget (wave-cycles); defaults to the max minted roundBudget. */
  maxRounds?: number;
  clock?: Clock;
};

export type DispatchOutcome = {
  rounds: number;
  exhausted: boolean;
  tasks: SwarmTaskResult[];
  artifacts: string[];
  state: DispatchState;
};

export type DispatchResult = { ok: true; outcome: DispatchOutcome } | { ok: false; stage: "dispatch"; error: string };

export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

export function realClock(): Clock {
  return { sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
}

/**
 * Ordered, JSON-friendly snapshot of a dispatch run. `tasks` follows schema
 * task order throughout; `rounds` counts wave-cycles and keeps counting
 * across resume calls, so an exhausted budget is not reset by resuming.
 */
export type DispatchState = {
  roster: Roster;
  tasks: DispatchTaskState[];
  rounds: number;
  exhausted: boolean;
};

export type DispatchTaskState = {
  taskId: string;
  status: "pending" | "running" | "done" | "failed" | "suspended";
  /** Attempts consumed in the CURRENT dispatch pass (reset on resume). */
  attempts: number;
  /** Attached after a done task's draft is written to the run space dir. */
  refs: string[];
  sessionId?: string;
  error?: string;
  summary?: string;
};