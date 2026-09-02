// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// PLAN stage (dispatch-review §4): one orchestrator pass with the `architect`
// persona reads goal + artifact and emits a strict-JSON workflow schema.
//
// Failure discipline (plan §75): EVERY failure path returns a structured
// {ok:false, stage:"plan", error} — this module NEVER throws at its public
// surface, including when runPersona itself fails or the mock client rejects.

import type { EngineClient } from "../engine/index.ts";
import { runPersona } from "../engine/index.ts";
import { extractVerdictJson } from "../verdict/index.ts";
import type { ModelSlot, PersonaLike, PlanResult, WorkflowSchema, WorkflowTask } from "./types.ts";

export type PlanOptions = {
  client: EngineClient;
  directory: string;
  architectPersona: PersonaLike;
  model: ModelSlot;
  /** What the swarm must achieve, in plain language. */
  goal: string;
  /** The artifact under consideration (path or inline text, as the driver provides). */
  artifact: string;
  timeoutMs?: number;
  /** Plan §75: verdict-layer repair PATTERN applied to the schema pass (verdict's own repair is Verdict-typed). */
  repair?: (badText: string, why: string) => string | Promise<string>;
};

/**
 * Strict-JSON instruction sent to the architect. The contract keys
 * (`tasks`, `instructions`, `dependsOn`, `concurrency`) are structural tokens
 * the runtime parses on — the driver/tests assert on them, not on prose.
 */
export function buildPlanInstruction(goal: string, artifact: string): string {
  return [
    "You are SIBYL's workflow architect. Plan a small multi-worker analysis swarm for the goal and artifact below.",
    "Respond with EXACTLY ONE JSON object and nothing else (no prose, no markdown fences, no extra keys):",
    '{"tasks":[{"id":"<unique non-empty id>","title":"<short title>","instructions":"<detailed worker instructions>","dependsOn":["<existing task ids>"]}],"concurrency":<integer >= 1>,"notes":"<optional plain text>"}',
    "Rules:",
    "- tasks: non-empty array; each task needs a distinct non-empty id, a title, non-empty instructions, and dependsOn listing only ids that exist in the same task list (empty array when none).",
    "- concurrency: integer >= 1 (how many workers may run in parallel).",
    "- notes: optional free-form rationale string.",
    `GOAL: ${goal}`,
    `ARTIFACT: ${artifact}`,
  ].join("\n");
}

const SCHEMA_KEYS = ["tasks", "concurrency", "notes"] as const;
const TASK_KEYS = ["id", "title", "instructions", "dependsOn"] as const;

// Audit F3: architect output is untrusted — bound its size so a hostile or
// runaway plan cannot exhaust memory/dispatch before the fail-closed verdict.
const MAX_PLAN_TASKS = 64;
const MAX_TASK_ID_CHARS = 64;
const MAX_TASK_TITLE_CHARS = 200;
const MAX_TASK_INSTRUCTIONS_CHARS = 8192;

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : describeValue(e);
}

type SchemaAttempt = { ok: true; schema: WorkflowSchema } | { ok: false; why: string };

/** extract -> JSON.parse -> validate; the repair output re-runs this same chain. */
async function attemptParseSchema(text: string): Promise<SchemaAttempt> {
  const raw = extractVerdictJson(text);
  if (raw === null) return { ok: false, why: "architect output contained no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, why: `architect JSON is not parseable: ${String(e)}` };
  }
  const checked = validateWorkflowSchema(parsed);
  if (!checked.ok) return { ok: false, why: `workflow schema invalid: ${checked.error}` };
  return { ok: true, schema: checked.value };
}

/** Hand-rolled narrowing validator (verdict-layer style); never throws. */
export function validateWorkflowSchema(raw: unknown): { ok: true; value: WorkflowSchema } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `workflow schema must be a JSON object, got ${describeValue(raw)}` };
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!(SCHEMA_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown top-level key "${key}" (strict schema allows tasks, concurrency, notes)` };
    }
  }
  if (!Array.isArray(root.tasks) || root.tasks.length === 0) {
    return { ok: false, error: `tasks must be a non-empty array, got ${describeValue(root.tasks)}` };
  }
  if (root.tasks.length > MAX_PLAN_TASKS) {
    return { ok: false, error: `tasks must contain at most ${MAX_PLAN_TASKS} entries, got ${root.tasks.length}` };
  }
  const seen = new Set<string>();
  const tasks: WorkflowTask[] = [];
  for (const [index, entry] of root.tasks.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `tasks[${index}] must be an object, got ${describeValue(entry)}` };
    }
    const task = entry as Record<string, unknown>;
    for (const key of Object.keys(task)) {
      if (!(TASK_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: `tasks[${index}] has unknown key "${key}" (strict schema allows id, title, instructions, dependsOn)` };
      }
    }
    const { id, title, instructions, dependsOn } = task;
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, error: `tasks[${index}].id must be a non-empty string, got ${describeValue(id)}` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `duplicate task id "${id}"` };
    }
    seen.add(id);
    if (id.length > MAX_TASK_ID_CHARS) {
      return { ok: false, error: `tasks[${index}].id must be at most ${MAX_TASK_ID_CHARS} chars, got ${id.length}` };
    }
    if (typeof title !== "string") {
      return { ok: false, error: `tasks[${index}].title must be a string, got ${describeValue(title)}` };
    }
    if (title.length > MAX_TASK_TITLE_CHARS) {
      return { ok: false, error: `tasks[${index}].title must be at most ${MAX_TASK_TITLE_CHARS} chars, got ${title.length}` };
    }
    if (typeof instructions !== "string" || instructions.length === 0) {
      return { ok: false, error: `tasks[${index}].instructions must be a non-empty string, got ${describeValue(instructions)}` };
    }
    if (instructions.length > MAX_TASK_INSTRUCTIONS_CHARS) {
      return { ok: false, error: `tasks[${index}].instructions must be at most ${MAX_TASK_INSTRUCTIONS_CHARS} chars, got ${instructions.length}` };
    }
    if (!Array.isArray(dependsOn)) {
      return { ok: false, error: `tasks[${index}].dependsOn must be an array, got ${describeValue(dependsOn)}` };
    }
    if (!dependsOn.every((d): d is string => typeof d === "string")) {
      return { ok: false, error: `tasks[${index}].dependsOn must contain only task id strings` };
    }
    tasks.push({ id, title, instructions, dependsOn: (dependsOn as string[]).slice() });
  }
  // Second pass: dependsOn may reference ANY id (forward refs included).
  for (const task of tasks) {
    const unknownDep = task.dependsOn.find((d) => !seen.has(d));
    if (unknownDep !== undefined) {
      return { ok: false, error: `tasks[${task.id}].dependsOn references unknown task id "${unknownDep}"` };
    }
  }
  const { concurrency, notes } = root;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
    return { ok: false, error: `concurrency must be an integer >= 1, got ${describeValue(concurrency)}` };
  }
  if (notes !== undefined && typeof notes !== "string") {
    return { ok: false, error: `notes must be a string when present, got ${describeValue(notes)}` };
  }
  const value: WorkflowSchema = notes === undefined ? { tasks, concurrency } : { tasks, concurrency, notes };
  return { ok: true, value };
}

/**
 * PLAN pass — runs the architect persona once and validates its strict-JSON
 * schema. Parse/validate/failure ALL return {ok:false, stage:"plan", error};
 * runPersona never rejects but may return a failure result — handled here too.
 */
export async function planWorkflow(opts: PlanOptions): Promise<PlanResult> {
  let result;
  try {
    result = await runPersona({
      client: opts.client,
      directory: opts.directory,
      persona: opts.architectPersona,
      model: opts.model,
      inputText: buildPlanInstruction(opts.goal, opts.artifact),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (e) {
    return { ok: false, stage: "plan", error: `architect runPersona threw: ${String(e)}` };
  }
  if (!result.ok) {
    return { ok: false, stage: "plan", error: `architect persona failed: ${result.error ?? "unknown error"}` };
  }
  const first = await attemptParseSchema(result.text);
  if (first.ok) return { ok: true, schema: first.schema };
  if (opts.repair === undefined) return { ok: false, stage: "plan", error: first.why };

  let repairedText: string;
  try {
    repairedText = await opts.repair(result.text, first.why);
  } catch (e) {
    return { ok: false, stage: "plan", error: `${first.why} + plan-repair-failed: ${errorMessage(e)}` };
  }

  const second = await attemptParseSchema(repairedText);
  if (second.ok) return { ok: true, schema: second.schema };
  return { ok: false, stage: "plan", error: `${first.why} + plan-repair-invalid: ${second.why}` };
}