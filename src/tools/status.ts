// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_status — a pure READ of the run store. No arguments lists every run
// (oldest first, newest last); a runId argument prints that run's full record
// plus its spaceDir. store.load() never throws, so a corrupt/missing state
// file degrades to the empty listing, exactly as the state layer promises.

import { tool } from "@opencode-ai/plugin";

import { formatRunLine, internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const STATUS_TOOL_NAME = "sibyl_status";

export function buildStatusTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL status: list recorded sibyl_consult/sibyl_swarm runs (newest last) from the durable run store, " +
      "or show one run's full record and spaceDir when given its runId.",
    args: {
      runId: tool.schema.string().min(1).optional().describe("Run id (sibyl-<ts>-<hex>) to inspect; omit for the listing."),
    },
    execute: async (args, context) => statusExecute(deps, args, context),
  });
}

/** Testable core behind the tool wrapper (same signature the host drives). */
export async function statusExecute(
  deps: ToolDeps,
  args: { runId?: string | undefined },
  _context: ToolContextLike,
): Promise<string> {
  try {
    if (args.runId !== undefined) {
      const run = await deps.store.getRun(args.runId);
      if (run === undefined) {
        return `SIBYL status: no run ${args.runId} (store: ${deps.store.runsFile})`;
      }
      return [`SIBYL RUN ${run.runId}`, formatRunLine(run)].join("\n");
    }
    const runs = await deps.store.load();
    if (runs.length === 0) {
      return `no sibyl runs recorded (store: ${deps.store.runsFile})`;
    }
    return [`SIBYL RUNS (${String(runs.length)}, oldest first)`, ...runs.map(formatRunLine)].join("\n");
  } catch (err) {
    return internalError(STATUS_TOOL_NAME, err);
  }
}
