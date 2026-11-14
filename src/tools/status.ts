// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_status — a pure READ of the run store. No arguments lists every run
// (oldest first, newest last); a runId argument prints that run's full record
// plus its spaceDir. store.load() never throws, so a corrupt/missing state
// file degrades to the empty listing, exactly as the state layer promises.

import { readFileSync } from "node:fs";
import { z } from "zod";

import { defineTool } from "./define.ts";

import { loadLedger } from "../state/chamber.ts";
import { dirname, join } from "node:path";

import { formatRunLine, internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const STATUS_TOOL_NAME = "sibyl_status";

export function buildStatusTool(deps: ToolDeps) {
  return defineTool(deps, {
    name: STATUS_TOOL_NAME,
    description:
      "SIBYL status: list recorded sibyl_consult/sibyl_swarm runs (newest last) from the durable run store, " +
      "or show one run's full record and spaceDir when given its runId.",
    args: {
      runId: z.string().min(1).optional().describe("Run id (sibyl-<ts>-<hex>) to inspect; omit for the listing."),
    },
    core: async (args, context) => statusExecute(deps, args, context),
  });
}

/** Session-face truth for one run (ballot H must_fix 2): the summary lives on
 * the record; the SESSIONS.json ledger is the ledger. A missing ledger means
 * the run predates the wheel — say that plainly instead of failing. */
function reclaimFace(deps: ToolDeps, runId: string): string {
  const space = join(dirname(deps.store.runsFile), "spaces", runId);
  let ledger: string[];
  try {
    ledger = readFileSync(join(space, "SESSIONS.json"), "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return `sessions: no SESSIONS.json under ${space} (run predates the reclaim wheel, or sessions kept)`;
  }
  const ids = new Set<string>();
  const parse = (raw: string): { kind?: string; sessionIds?: string[] } | undefined => {
    try {
      return JSON.parse(raw) as { kind?: string; sessionIds?: string[] };
    } catch {
      return undefined;
    }
  };
  for (const line of ledger) {
    const e = parse(line);
    if (e === undefined) continue;
    if (e.kind === "group") for (const id of e.sessionIds ?? []) ids.add(id);
    else ids.add(line.trim());
  }
  const dead = join(space, "DEAD-LETTER.jsonl");
  let deadN = 0;
  try {
    deadN = readFileSync(dead, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    /* no dead letter */
  }
  const rows = ledger.slice(0, 5).map((l) => l.slice(0, 200));
  const more = ledger.length > 5 ? `\n  … ${String(ledger.length - 5)} more` : "";
  return `sessions ledger (${space}): ${String(ids.size)} ids${deadN > 0 ? `; DEAD-LETTER ${String(deadN)}` : ""}\n` +
    rows.map((r) => `  ${r}`).join("\n") + more;
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
      return [`SIBYL RUN ${run.runId}`, formatRunLine(run), reclaimFace(deps, run.runId)].filter((l) => l !== "").join("\n");
    }
    const runs = await deps.store.load();
    const ledger = await loadLedger(join(dirname(deps.store.runsFile), "chamber-ledger.jsonl"));
    const chamberLines = ledger.rows.slice(-5).map((r) =>
      `${r.runId} chamber/${r.profile} ${r.terminal ?? "running"} rounds=${String(r.rounds)} artifacts=${String(r.artifacts.length)} judge=${r.judgeModelId} dir=${r.runDir}`,
    );
    if (runs.length === 0 && chamberLines.length === 0) {
      return `no sibyl runs recorded (store: ${deps.store.runsFile})`;
    }
    const head = runs.length === 0 ? [] : [`SIBYL RUNS (${String(runs.length)}, oldest first)`, ...runs.map(formatRunLine)];
    const tail = chamberLines.length === 0 ? [] : [`CHAMBER LEDGER (last ${String(chamberLines.length)}; drops: ${String(ledger.dropped.length)})`, ...chamberLines];
    return [...head, ...tail].join("\n");
  } catch (err) {
    return internalError(STATUS_TOOL_NAME, err);
  }
}
