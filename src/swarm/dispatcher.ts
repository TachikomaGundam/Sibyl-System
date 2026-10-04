// provenance: original clean-room Sibyl-System implementation (plan task 7), no swarm code copied
//
// DISPATCH stage (dispatch-review §4): batched fan-out with staggered launch,
// per-task timeout (engine timeoutMs), rate-limit → SUSPEND (never fail),
// same-worker retry cap, resume-by-id (continues a prior DispatchState),
// ordered aggregation (results in schema task order). Dependency respect via
// topological wave batching; a dependency cycle yields a structured error.
//
// Never throws at the public surface: every failure path returns
// {ok:false, stage:"dispatch", error}. Promise.all fan-out over a wave
// COLLECTS per-task results (engine runPersona never rejects and never fails
// the batch — check result.ok per child, then suspend/retry/fail per task).

import { runPersona, type PersonaRunResult } from "../engine/index.ts";
import { classifyFailure, formatTerminalRow } from "../terminal.ts";
import type { TerminalStatus } from "../terminal.ts";
import { DEFAULT_SUMMARY_MAX_CHARS, summarizeTaskOutput } from "./aggregate.ts";
import {
  realClock,
  type Clock,
  type DispatchOptions,
  type DispatchOutcome,
  type DispatchResult,
  type DispatchState,
  type DispatchTaskState,
  type ModelSlot,
  type PersonaLike,
  type Roster,
  type SwarmTaskResult,
  type TaskStatus,
  type WorkflowSchema,
  type WorkflowTask,
} from "./types.ts";

// Rate-limit classifier — the SUSPEND marker (dispatch-review: rate-limit is
// NOT a failure; the task is marked suspended and retryable via resume).
// Exported so tests (and the driver) can assert the classification directly.
export function isRateLimitError(error: string): boolean {
  return error.includes("429") || /rate/i.test(error);
}

function describeFailure(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- graph validation --------------------------------------------------------

function findCycle(schema: WorkflowSchema): string | null {
  const taskBy = new Map(schema.tasks.map((t) => [t.id, t] as const));
  const marks = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string | null => {
    const mark = marks.get(id) ?? 0;
    if (mark === 2) return null;
    if (mark === 1) return `${stack.slice(stack.indexOf(id)).join(" -> ")} -> ${id}`;
    marks.set(id, 1);
    stack.push(id);
    for (const dep of taskBy.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    marks.set(id, 2);
    return null;
  };
  for (const task of schema.tasks) {
    const cycle = visit(task.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

export function graphIssue(schema: WorkflowSchema): string | null {
  const ids = new Set<string>();
  for (const task of schema.tasks) {
    if (ids.has(task.id)) return `duplicate task id "${task.id}"`;
    ids.add(task.id);
  }
  for (const task of schema.tasks) {
    const missing = task.dependsOn.find((d) => !ids.has(d));
    if (missing !== undefined) return `task "${task.id}" depends on unknown task id "${missing}"`;
  }
  const cycle = findCycle(schema);
  return cycle === null ? null : `dependency cycle: ${cycle}`;
}

// --- execution ---------------------------------------------------------------

type Ctx = {
  roster: Roster;
  taskBy: Map<string, WorkflowTask>;
  workerByTask: Map<string, { persona: PersonaLike; model: ModelSlot; workerId: string; timeoutMs: number }>;
  stateBy: Map<string, DispatchTaskState>;
  client: DispatchOptions["client"];
  directory: string;
  parentID: DispatchOptions["parentID"];
  concurrencyK: number;
  staggerMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  summaryMaxChars: number;
  maxRounds: number;
  clock: Clock;
  writeDraft: DispatchOptions["writeDraft"];
  writeTerminal: DispatchOptions["writeTerminal"];
};

type Resolved = Omit<Ctx, "roster" | "taskBy" | "workerByTask" | "stateBy">;

function makeState(roster: Roster): DispatchState {
  return {
    roster,
    rounds: 0,
    exhausted: false,
    tasks: roster.schema.tasks.map((t) => ({ taskId: t.id, status: "pending", attempts: 0, refs: [] })),
  };
}

function makeCtx(state: DispatchState, resolved: Resolved): Ctx {
  return {
    ...resolved,
    roster: state.roster,
    taskBy: new Map(state.roster.schema.tasks.map((t) => [t.id, t] as const)),
    workerByTask: new Map(state.roster.workers.map((w) => [w.taskId, w] as const)),
    stateBy: new Map(state.tasks.map((t) => [t.taskId, t] as const)),
  };
}

function depsDone(ctx: Ctx, taskId: string): boolean {
  const task = ctx.taskBy.get(taskId);
  if (task === undefined) return false;
  return task.dependsOn.every((depId) => ctx.stateBy.get(depId)?.status === "done");
}

// Downstream prompts receive upstream CONCLUSIONS only — never full drafts.
function composeTaskPrompt(ctx: Ctx, taskId: string): string {
  const task = ctx.taskBy.get(taskId);
  const lines: string[] = [];
  for (const depId of task?.dependsOn ?? []) {
    const summary = ctx.stateBy.get(depId)?.summary;
    if (summary !== undefined) lines.push(`- ${depId}: ${summary}`);
  }
  const instruction = task?.instructions ?? "";
  return lines.length === 0 ? instruction : `${instruction}\n\nUpstream conclusions (from completed dependencies):\n${lines.join("\n")}`;
}

/** W2: append the task's terminal line. Returns false when the append threw
 * — callers on the done path must demote (a ballot without its record never
 * stands); on failure paths the missing line is honestly counted by the gate. */
async function recordTerminal(
  ctx: Ctx,
  taskId: string,
  workerId: string,
  status: TerminalStatus,
  session: string,
  detail: string,
): Promise<boolean> {
  if (ctx.writeTerminal === undefined) return true;
  try {
    await ctx.writeTerminal(
      formatTerminalRow(new Date(), { task: taskId, worker: workerId, status, session, detail }),
    );
    return true;
  } catch (e) {
    console.error(`[sibyl dispatch] terminal line for ${taskId} failed to write: ${describeFailure(e)}`);
    return false;
  }
}

async function runTask(ctx: Ctx, task: DispatchTaskState): Promise<void> {
  const worker = ctx.workerByTask.get(task.taskId);
  if (worker === undefined) {
    task.status = "failed";
    task.error = `no worker spec for task "${task.taskId}"`;
    await recordTerminal(ctx, task.taskId, "-", "error", "-", task.error);
    return;
  }
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    task.status = "running";
    task.attempts = attempt;
    if (attempt > 1) await ctx.clock.sleep(ctx.retryDelayMs);
    let result: PersonaRunResult;
    try {
      result = await runPersona({
        client: ctx.client,
        directory: ctx.directory,
        persona: worker.persona,
        model: worker.model,
        inputText: composeTaskPrompt(ctx, task.taskId),
        timeoutMs: worker.timeoutMs,
        parentID: ctx.parentID,
      });
    } catch (e) {
      task.status = "failed";
      task.error = `runPersona threw: ${describeFailure(e)}`;
      await recordTerminal(ctx, task.taskId, worker.workerId, classifyFailure(task.error), "-", task.error);
      return;
    }
    if (result.ok) {
      // Empty-honey guard (2026-10-04 swarm first campaign): a session that
      // exits with no content cast no ballot — the old tally showed it as
      // done. Absence is not participation, so it is a failure, not a vote.
      if (result.text.trim().length === 0) {
        task.error = "empty-reply: worker session ended with no content (absence is not a ballot)";
      } else {
        let ref: string;
        try {
          ref = await ctx.writeDraft({ taskId: task.taskId, workerId: worker.workerId, text: result.text });
        } catch (e) {
          task.status = "failed";
          task.error = `draft write failed: ${describeFailure(e)}`;
          await recordTerminal(ctx, task.taskId, worker.workerId, "error", result.sessionID, task.error);
          return;
        }
        const recorded = await recordTerminal(ctx, task.taskId, worker.workerId, "ok", result.sessionID, `draft=${ref}`);
        if (!recorded) {
          task.status = "failed";
          task.error = "terminal record write failed (W2: done without its record never stands)";
          return;
        }
        task.refs.push(ref);
        task.summary = summarizeTaskOutput(result.text, ctx.summaryMaxChars);
        if (result.sessionID !== "") task.sessionId = result.sessionID;
        task.status = "done";
        return;
      }
    } else {
      task.error = result.error ?? "unknown engine error";
    }
    if (isRateLimitError(task.error)) {
      task.status = "suspended";
      await recordTerminal(ctx, task.taskId, worker.workerId, "error", "-", `suspended: ${task.error}`);
      return;
    }
  }
  task.status = "failed";
  await recordTerminal(ctx, task.taskId, worker.workerId, classifyFailure(task.error ?? ""), "-", task.error ?? "attempts exhausted");
}

async function runWaves(ctx: Ctx, state: DispatchState): Promise<void> {
  for (;;) {
    const schedulable = state.tasks.filter((t) => t.status === "pending" && depsDone(ctx, t.taskId));
    if (schedulable.length === 0) break;
    if (state.rounds >= ctx.maxRounds) {
      state.exhausted = true;
      for (const t of state.tasks) {
        if (t.status === "pending") {
          t.status = "suspended";
          await recordTerminal(ctx, t.taskId, ctx.workerByTask.get(t.taskId)?.workerId ?? "-", "error", "-", "exhausted: round budget spent before launch");
        }
      }
      break;
    }
    state.rounds += 1;
    const batch = schedulable.slice(0, ctx.concurrencyK);
    const launches = batch.map((task, index) => (async () => {
      await ctx.clock.sleep(index * ctx.staggerMs);
      await runTask(ctx, task);
    })());
    await Promise.all(launches);
  }
  for (const t of state.tasks) {
    if (t.status === "pending") {
      t.status = "failed";
      t.error = "blocked by non-done dependency";
      await recordTerminal(ctx, t.taskId, ctx.workerByTask.get(t.taskId)?.workerId ?? "-", "error", "-", t.error);
    }
  }
}

function materialize(state: DispatchState): DispatchOutcome {
  // After runWaves every task is terminal (done/failed/suspended); map any
  // theoretically-unreachable non-terminal status fail-closed to "failed".
  const tasks: SwarmTaskResult[] = state.tasks.map((t) => {
    const status: TaskStatus = t.status === "done" ? "done" : t.status === "suspended" ? "suspended" : "failed";
    return {
      id: t.taskId,
      status,
      ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
      ...(t.summary !== undefined ? { summary: t.summary } : {}),
    };
  });
  return {
    rounds: state.rounds,
    exhausted: state.exhausted,
    tasks,
    artifacts: state.tasks.flatMap((t) => t.refs),
    state,
  };
}

async function run(prior: DispatchState | undefined, roster: Roster, opts: DispatchOptions): Promise<DispatchResult> {
  const fail = (error: string): DispatchResult => ({ ok: false, stage: "dispatch", error });
  try {
    const issue = graphIssue(roster.schema);
    if (issue !== null) return fail(issue);
    if (roster.workers.length === 0) return fail("roster has no workers");
    if (!Number.isInteger(opts.concurrencyK) || opts.concurrencyK < 1) return fail(`concurrencyK must be an integer >= 1, got ${opts.concurrencyK}`);
    if (opts.staggerMs < 0) return fail(`staggerMs must be >= 0, got ${opts.staggerMs}`);
    const maxAttempts = opts.maxAttempts ?? 2;
    const retryDelayMs = opts.retryDelayMs ?? 500;
    const summaryMaxChars = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    if (maxAttempts < 1) return fail(`maxAttempts must be >= 1, got ${maxAttempts}`);
    if (retryDelayMs < 0) return fail(`retryDelayMs must be >= 0, got ${retryDelayMs}`);
    if (summaryMaxChars < 1) return fail(`summaryMaxChars must be >= 1, got ${summaryMaxChars}`);
    const maxRounds = opts.maxRounds ?? Math.max(...roster.workers.map((w) => w.roundBudget));
    if (maxRounds < 1) return fail(`maxRounds must be >= 1, got ${maxRounds}`);
    const resolved: Resolved = {
      client: opts.client,
      directory: opts.directory,
      parentID: opts.parentID,
      concurrencyK: opts.concurrencyK,
      staggerMs: opts.staggerMs,
      maxAttempts,
      retryDelayMs,
      summaryMaxChars,
      maxRounds,
      clock: opts.clock ?? realClock(),
      writeDraft: opts.writeDraft,
      writeTerminal: opts.writeTerminal,
    };
    let state = prior ?? makeState(roster);
    if (prior !== undefined) {
      state.exhausted = false; // stale end-of-run flag: runWaves re-asserts it only if the new budget is still insufficient
      for (const t of state.tasks) {
        if (t.status === "pending" || t.status === "suspended") {
          t.status = "pending";
          t.attempts = 0;
          delete t.error;
        }
      }
    }
    await runWaves(makeCtx(state, resolved), state);
    return { ok: true, outcome: materialize(state) };
  } catch (e) {
    return fail(`dispatch crashed: ${describeFailure(e)}`);
  }
}

// Full dispatch pass over a minted roster.
export async function dispatchRoster(roster: Roster, opts: DispatchOptions): Promise<DispatchResult> {
  return run(undefined, roster, opts);
}

// Resume-by-id: continues a prior DispatchState — pending/suspended tasks get
// a fresh attempt budget, rounds keep counting, completed work is never re-run.
export async function resumeDispatch(state: DispatchState, opts: DispatchOptions): Promise<DispatchResult> {
  return run(state, state.roster, opts);
}