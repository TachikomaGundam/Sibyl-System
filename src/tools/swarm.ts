// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_swarm — a THIN driver of the src/swarm/ pipeline: PLAN (architect emits
// a workflow schema) -> MINT (deterministic worker roster from the PERSONAS
// registry) -> DISPATCH (dependency-wave execution, full drafts into the run's
// spaceDir) -> AGGREGATE (buildReport) -> optional LLM judge (single
// runPersona at the options.swarm.judge slot, output gated by isSwarmVerdict;
// anything else keeps the fail-closed derived verdict). The driver adds no
// policy of its own and NEVER throws at the execute boundary: every stage
// failure lands as `status:"failed"` on the run record and a readable string.

import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { tool } from "@opencode-ai/plugin";

import { COUNCILORS } from "../council/index.ts";
import { runPersona } from "../engine/index.ts";
import { PERSONAS } from "../personas.ts";
import { buildReport } from "../swarm/aggregate.ts";
import { dispatchRoster } from "../swarm/dispatcher.ts";
import { mintRoster } from "../swarm/minter.ts";
import { planWorkflow } from "../swarm/planner.ts";
import type { SwarmReport, SwarmVerdict } from "../swarm/types.ts";
import type { RunRecord } from "../state/index.ts";
import { buildRepairDemand } from "./consult.ts";
import { errMessage, internalError, readArtifact, slotForModel } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const SWARM_TOOL_NAME = "sibyl_swarm";

/** Prompt the optional judge sees: the AGGREGATE report, verdict-requested. */
export function buildJudgeInput(report: SwarmReport): string {
  const lines = [
    "You are the SIBYL swarm judge. Review the pipeline report below and rule on the produced artifact set.",
    `DERIVED VERDICT: ${report.verdict}`,
    `ROUNDS: ${String(report.rounds)}`,
    ...report.tasks.map((t) => `TASK ${t.id}: ${t.status}${t.summary === undefined ? "" : ` — ${t.summary}`}`),
    ...report.artifacts.map((a) => `ARTIFACT: ${a}`),
    "",
    'Respond with EXACTLY one word and nothing else: APPROVE, REJECT, or EXHAUSTED.',
  ];
  return lines.join("\n");
}

/** One-word verdict extraction; anything unrecognized is not a verdict. */
export function parseJudgeWord(text: string): SwarmVerdict | null {
  const word = text.trim().toUpperCase();
  if (word === "APPROVE" || word === "REJECT" || word === "EXHAUSTED") {
    return word satisfies SwarmVerdict;
  }
  return null;
}

export function buildSwarmTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL swarm: decompose a goal+artifact (file path or inline multi-line text, max 256 KiB) with the ARCHITECT " +
      "persona into a dependency-wave workflow, run rotated councilor workers over it, and report the aggregated " +
      "verdict, per-task statuses, and draft artifact paths. Optional single judge pass when judge=true.",
    args: {
      artifact: tool.schema.string().min(1).describe("Path to the artifact, or its inline content (multi-line)."),
      goal: tool.schema.string().min(1).describe("What the swarm must produce or settle."),
      judge: tool.schema.boolean().optional().describe("Run the optional judge persona over the derived report (default: derived verdict only)."),
    },
    execute: async (args, context) => {
      try {
        return await swarmExecute(deps, args, context);
      } catch (err) {
        return internalError(SWARM_TOOL_NAME, err);
      }
    },
  });
}

type SwarmStageFailure = { stage: string; error: string };

/** Persists a terminal record; `failure` marks the run failed, else done. */
async function finishRun(
  deps: ToolDeps,
  record: RunRecord,
  patch: Partial<RunRecord> & { notes: string },
): Promise<void> {
  await deps.store.appendOrUpdate({
    ...record,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

/** Testable core behind the tool wrapper (same signature the host drives). */
export async function swarmExecute(
  deps: ToolDeps,
  args: { artifact: string; goal: string; judge?: boolean | undefined },
  context: ToolContextLike,
): Promise<string> {
  const { client, options, store } = deps;
  const directory = context.directory;

  const read = await readArtifact(args.artifact, directory);
  if (!read.ok) {
    return `SIBYL swarm: ${read.error}`;
  }
  const { record } = await store.createRun({ kind: "swarm", artifact: read.source, goal: args.goal });

  // --- PLAN: architect session; repair starts a FRESH architect session
  // (planWorkflow's repair seam carries no sessionID of its own).
  const architectModel = slotForModel(options.modelPool, undefined, PERSONAS.ARCHITECT.modelSlot);
  const plan = await planWorkflow({
    client,
    directory,
    architectPersona: { system: PERSONAS.ARCHITECT.system },
    model: architectModel,
    goal: args.goal,
    artifact: read.text,
    timeoutMs: options.timeoutMs,
    repair: async (_badText, why) => {
      const redo = await runPersona({
        client,
        directory,
        persona: { system: PERSONAS.ARCHITECT.system },
        model: architectModel,
        inputText:
          `${buildRepairDemand(why)} matching the workflow-schema contract: ` +
          '{"tasks":[{"id","title","instructions","dependsOn"}],"concurrency":<int >= 1>,"notes":<string>}',
        timeoutMs: options.timeoutMs,
      });
      return redo.ok ? redo.text : "";
    },
  });
  if (!plan.ok) return failRun(deps, record, { stage: "plan", error: plan.error });

  // --- MINT: workers rotate over the PERSONAS councilor entries (no fixed
  // roster constants; models rotate the configured pool in task order).
  const mint = mintRoster(plan.schema, {
    personas: COUNCILORS.map((id) => ({ system: PERSONAS[id].system })),
    modelPool: options.modelPool,
    roundBudget: options.maxRounds,
    timeoutMs: options.timeoutMs,
  });
  if (!mint.ok) return failRun(deps, record, { stage: "mint", error: mint.error });

  // --- DISPATCH: schema-concurrency capped by options.concurrencyK; full
  // worker drafts land as <workerId>.draft.md inside the run's spaceDir.
  const dispatch = await dispatchRoster(mint.roster, {
    client,
    directory,
    concurrencyK: Math.min(options.concurrencyK, plan.schema.concurrency),
    staggerMs: options.staggerMs,
    maxRounds: options.maxRounds,
    writeDraft: async ({ taskId, workerId, text }) => {
      const path = join(record.spaceDir, `${workerId}.draft.md`);
      try {
        await writeFile(path, `<!-- SIBYL swarm draft task=${taskId} worker=${workerId} -->\n${text}\n`, "utf8");
        return path;
      } catch (err) {
        return `<${path} write failed: ${errMessage(err)}>`;
      }
    },
  });
  if (!dispatch.ok) return failRun(deps, record, { stage: "dispatch", error: dispatch.error });

  // --- AGGREGATE + optional judge. buildReport derives the fail-closed
  // verdict; the judge may only REPLACE it with another isSwarmVerdict value.
  let report = buildReport({
    rounds: dispatch.outcome.rounds,
    exhausted: dispatch.outcome.exhausted,
    tasks: dispatch.outcome.tasks,
    artifacts: dispatch.outcome.artifacts,
  });
  let judgeNote = "judge=off";
  if (args.judge === true) {
    const judged = await runPersona({
      client,
      directory,
      persona: { system: "You are the SIBYL swarm judge. You rule on pipeline reports with exactly one word: APPROVE, REJECT, or EXHAUSTED." },
      model: slotForModel(options.modelPool, options.swarm.judge, undefined),
      inputText: buildJudgeInput(report),
      timeoutMs: options.timeoutMs,
    });
    const word = judged.ok ? parseJudgeWord(judged.text) : null;
    judgeNote =
      word === null
        ? `judge=inactive (${judged.ok ? "unrecognized verdict word" : `engine: ${judged.error ?? "?"}`}; derived kept)`
        : `judge=${word}${word === report.verdict ? "" : " (overrides derived " + report.verdict + ")"}`;
    if (word !== null) report = { ...report, verdict: word };
  }

  const counts = countTasks(report.tasks);
  await finishRun(deps, record, {
    status: "done",
    rounds: report.rounds,
    verdict: {
      verdict: report.verdict === "APPROVE" ? "APPROVE" : "REJECT",
      approvals: counts.done,
      rejects: counts.failed,
      errors: 0,
      missing: counts.suspended,
    },
    notes: `${judgeNote} · ${report.tasks.map((t) => `${t.id}=${t.status}`).join(",")}`,
  });

  const lines = [
    `SIBYL SWARM: ${report.verdict} run ${record.runId} (rounds=${String(report.rounds)} done=${String(counts.done)} failed=${String(counts.failed)} suspended=${String(counts.suspended)} ${judgeNote})`,
    ...report.tasks.map((t) => `  task: ${t.id} ${t.status}${t.sessionId === undefined ? "" : ` session=${t.sessionId}`}`),
    ...report.artifacts.map((a) => `  artifact: ${a}`),
    `  space: ${record.spaceDir}`,
    `  store: ${store.runsFile}`,
  ];
  return lines.join("\n");
}

function countTasks(tasks: readonly { status: string }[]): { done: number; failed: number; suspended: number } {
  let done = 0;
  let failed = 0;
  let suspended = 0;
  for (const t of tasks) {
    if (t.status === "done") done += 1;
    else if (t.status === "failed") failed += 1;
    else suspended += 1;
  }
  return { done, failed, suspended };
}

function failRun(deps: ToolDeps, record: RunRecord, failure: SwarmStageFailure): Promise<string> {
  return deps.store
    .appendOrUpdate({
      ...record,
      status: "failed",
      updatedAt: new Date().toISOString(),
      notes: `${failure.stage}: ${failure.error}`,
    })
    .then(() => `SIBYL SWARM: ${failure.stage} failed — ${failure.error} (run ${record.runId} marked failed)`);
}
