// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// MINT stage (dispatch-review §4): DETERMINISTIC worker-spec synthesis.
// Identical schema + pool + options → identical roster; different schema →
// different roster (same-input-rule, property-tested). The roster is DERIVED
// at runtime from the caller-provided persona list and model pool — there is
// NO fixed roster constant here (F5 gate). Unknown pool slots and empty
// inputs produce structured {ok:false, stage:"mint", error}, never a throw.

import type { MintResult, ModelPool, PersonaLike, WorkerSpec, WorkflowSchema, WorkflowTask } from "./types.ts";

export type MintOptions = {
  /** Candidate personas, rotated round-robin across tasks (task i → personas[i % n]). */
  personas: PersonaLike[];
  modelPool: ModelPool;
  /** Default per-worker round budget (wave-cycles) and task timeout. */
  roundBudget?: number;
  timeoutMs?: number;
  /** Model-slot selector; default rotates over modelPool keys in task order. */
  slotFor?: (task: WorkflowTask, index: number) => string;
};

export const DEFAULT_ROUND_BUDGET = 3;
export const DEFAULT_TIMEOUT_MS = 240_000;

/** Keep worker ids readable yet deterministic: worker-<index>-<slug(taskId)>. */
function slugify(id: string): string {
  const slug = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

/**
 * Derive one worker spec per schema task. Pure and total: any input that
 * cannot be satisfied (empty persona list, empty pool, unknown slot) yields
 * a structured mint error instead of throwing.
 */
export function mintRoster(schema: WorkflowSchema, opts: MintOptions): MintResult {
  const roundBudget = opts.roundBudget ?? DEFAULT_ROUND_BUDGET;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const poolKeys = Object.keys(opts.modelPool);
  if (poolKeys.length === 0) {
    return { ok: false, stage: "mint", error: "model pool is empty" };
  }
  if (opts.personas.length === 0) {
    return { ok: false, stage: "mint", error: "persona list is empty" };
  }
  const workers: WorkerSpec[] = [];
  for (const [index, task] of schema.tasks.entries()) {
    const slotKey = opts.slotFor ? opts.slotFor(task, index) : poolKeys[index % poolKeys.length];
    if (slotKey === undefined) {
      return { ok: false, stage: "mint", error: `no model slot derivable for task "${task.id}"` };
    }
    const model = opts.modelPool[slotKey];
    if (model === undefined) {
      return { ok: false, stage: "mint", error: `unknown model slot "${slotKey}"` };
    }
    const persona = opts.personas[index % opts.personas.length];
    if (persona === undefined) {
      return { ok: false, stage: "mint", error: `no persona derivable for task "${task.id}"` };
    }
    workers.push({
      workerId: `worker-${index}-${slugify(task.id)}`,
      taskId: task.id,
      persona,
      model,
      roundBudget,
      timeoutMs,
    });
  }
  return { ok: true, roster: { schema, workers } };
}