// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// sibyl_consult — the three-headed council as one tool call. Reads the artifact
// (path-or-inline, 256 KiB cap), fans the three fixed councilor personas out in
// ONE Promise.all over the engine, parses each reply into a Verdict (one
// in-session JSON-only repair shot per voter via parseVerdict's repair seam),
// tallies fail-closed with majority2of3, and persists the whole run through the
// state layer: running record first, per-voter full replies into the run's
// spaceDir, terminal record last. Nothing here throws across the execute
// boundary; every failure surfaces as a readable string.

import { join } from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import { tool } from "@opencode-ai/plugin";

import { COUNCILORS, tallyVotes } from "../council/index.ts";
import type { CouncilorId, CouncilVote } from "../council/index.ts";
import { runPersona } from "../engine/index.ts";
import { assessIndependence, independenceLabel } from "../independence.ts";
import { instrumentFace, rulesLabel } from "../instrument.ts";
import { classifyFailure, deadFaceCount, deadWithoutRecord, formatTerminalRow, parseTerminalRows } from "../terminal.ts";
import { parseVerdict } from "../verdict/index.ts";
import { PERSONAS, repairDemand } from "../personas.ts";
import type { RunRecord } from "../state/index.ts";
import { errMessage, internalError, readArtifact, runInSession, slotForModel } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const CONSULT_TOOL_NAME = "sibyl_consult";

/** Prompt each councilor sees: the pinned goal plus the artifact under audit. */
export function buildConsultInput(goal: string, artifactText: string): string {
  return `Audit the artifact below against the stated goal and cast your verdict.\n\nGOAL:\n${goal}\n\nARTIFACT:\n${artifactText}`;
}

/** The demand sent back into a voter's own session when its first reply did
 * not parse (parseVerdict's ONE repair shot). The text itself lives in the
 * persona registry — single source with the W3 instrument face. */
export { repairDemand as buildRepairDemand };

/** Per-voter record kept alongside the tally: ballot + where the full reply landed. */
type VoterOutcome = {
  id: CouncilorId;
  vote: CouncilVote;
  replyPath: string;
  sessionId: string;
  modelApplied: string | null;
  latencyMs: number;
};

const REPLY_HEADER =
  "<!-- SIBYL consult voter reply (plan task 8). Full raw session text below; " +
  "parse/repair metadata at the end. -->\n";

function renderReply(voter: CouncilorId, text: string, meta: string): string {
  return `${REPLY_HEADER}\n## ${voter}\n\n${text}\n\n---\n${meta}\n`;
}

/** One voter's fan-out job (bundled to keep castVote under the 3-param smell). */
type VoteJob = {
  deps: ToolDeps;
  directory: string;
  spaceDir: string;
  goal: string;
  artifactText: string;
  id: CouncilorId;
  parentID: string;
};

/**
 * Drive one councilor end to end: engine call -> verdict parse (with the
 * in-session repair closure) -> full reply written into spaceDir. NEVER
 * rejects: engine failures become error votes; a reply-write failure degrades
 * the reply path into an inline note but keeps the ballot.
 */
async function castVote(job: VoteJob): Promise<VoterOutcome> {
  const { deps, id } = job;
  const { directory, spaceDir, goal, artifactText, parentID } = job;
  const { client, options } = deps;
  const persona = PERSONAS[id];
  const model = slotForModel(options.modelPool, options.voters[id], persona.modelSlot);
  const replyPath = join(spaceDir, `${id}.md`);

  const result = await runPersona({
    client,
    directory,
    persona: { system: persona.system },
    model,
    inputText: buildConsultInput(goal, artifactText),
    timeoutMs: options.timeoutMs,
    parentID,
  });

  if (!result.ok) {
    const error = `${result.stage ?? "engine"}: ${result.error ?? "unknown error"}`;
    const vote: CouncilVote = { id, ok: false, error };
    const replyAt = await safeWrite(replyPath, renderReply(id, "(no reply — engine call failed)", `ballot: ERROR ${error}`));
    return { id, vote, replyPath: replyAt, sessionId: result.sessionID, modelApplied: result.modelApplied, latencyMs: result.latencyMs };
  }

  // parseVerdict's single repair shot: a follow-up prompt INTO THIS voter's own
  // session. A failed follow-up yields "" -> the parse falls through to the
  // fail-closed "verdict-unparseable" sentinel.
  const verdict = await parseVerdict(result.text, async (_badText, why) => {
    const followed = await runInSession(
      client,
      directory,
      result.sessionID,
      model,
      repairDemand(why),
      options.timeoutMs,
    );
    return followed.ok ? followed.text : "";
  });

  // The sentinel is not a ballot: an unparseable reply means this seat failed to
  // answer, not that it voted REJECT (mirrors the CANNOT_ANSWER semantics).
  const unparseable = verdict.reasons[0]?.startsWith("verdict-unparseable") ?? false;
  const vote: CouncilVote = unparseable
    ? { id, ok: false, error: verdict.reasons[0] ?? "verdict-unparseable" }
    : { id, ok: true, verdict };
  const meta = unparseable
    ? `ballot: ERROR ${verdict.reasons[0] ?? "verdict-unparseable"} (reply did not parse)`
    : `ballot: ${verdict.verdict} (confidence ${String(verdict.confidence)}) · ` +
      `session ${result.sessionID} · model ${result.modelApplied ?? "host-picked"} · ${String(result.latencyMs)}ms`;
  const replyAt = await safeWrite(replyPath, renderReply(id, result.text, meta));
  return { id, vote, replyPath: replyAt, sessionId: result.sessionID, modelApplied: result.modelApplied, latencyMs: result.latencyMs };
}

async function safeWrite(path: string, text: string): Promise<string> {
  try {
    await writeFile(path, text, "utf8");
    return path;
  } catch (err) {
    return `<${path} write failed: ${errMessage(err)}>`;
  }
}

export function buildConsultTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL council consult: audit an artifact (file path or inline multi-line text, max 256 KiB) with the three " +
      "councilor personas (MELCHIOR/BALTHASAR/CASPER) in parallel and return the fail-closed 2/3 verdict " +
      "(APPROVE / REJECT / CANNOT_ANSWER when error or missing seats left no decision) plus reasons, must-fix " +
      "items, run id, and per-voter reply files.",
    args: {
      artifact: tool.schema.string().min(1).describe("Path to the artifact, or its inline content (multi-line)."),
      goal: tool.schema.string().min(1).describe("What the artifact is supposed to achieve."),
    },
    execute: async (args, context) => {
      try {
        return await consultExecute(deps, args, context);
      } catch (err) {
        return internalError(CONSULT_TOOL_NAME, err);
      }
    },
  });
}

/** Testable core behind the tool wrapper (same signature the host drives). */
export async function consultExecute(
  deps: ToolDeps,
  args: { artifact: string; goal: string },
  context: ToolContextLike,
): Promise<string> {
  const read = await readArtifact(args.artifact, context.directory);
  if (!read.ok) {
    return `SIBYL consult: ${read.error}`;
  }

  // W1 convener-recusal: assess BEFORE the vote — a party may not choose its
  // own court, and the finding must be on the record whichever way the poll goes.
  const independence = await assessIndependence(deps.client, context.directory, context.sessionID, read);

  const { record } = await deps.store.createRun({
    kind: "consult",
    artifact: read.source,
    goal: args.goal,
  });

  const outcomes = await Promise.all(
    COUNCILORS.map((id): Promise<VoterOutcome> =>
      castVote({ deps, directory: context.directory, spaceDir: record.spaceDir, goal: args.goal, artifactText: read.text, id, parentID: context.sessionID }),
    ),
  );

  const tally = tallyVotes(outcomes.map((o) => o.vote));

  // W2 absence-as-disability: every seat must leave a terminal row in
  // TERMINALS.txt (ok|error|timeout) before the tally is honored. A seat
  // whose row cannot be written is dead-without-record: named on the receipt
  // face, forcing CANNOT_ANSWER — never folded into any vote either way.
  const terminalsPath = join(record.spaceDir, "TERMINALS.txt");
  await Promise.all(
    outcomes.map((o) => {
      const vote = o.vote;
      const status = "missing" in vote ? "error" : vote.ok ? "ok" : classifyFailure(vote.error);
      const detail = "missing" in vote || !vote.ok ? `ballot=${ballotTag(vote)}` : `ballot=${vote.verdict.verdict}`;
      const line = formatTerminalRow(new Date(), {
        task: o.id,
        worker: o.id,
        status,
        session: o.sessionId,
        detail,
      });
      return appendFile(terminalsPath, `${line}\n`, "utf8").catch((err: unknown) => {
        console.error(`[sibyl consult] terminal row for ${o.id} failed to write: ${errMessage(err)}`);
      });
    }),
  );
  // Read-back authority: a seat is recorded only if its row parses out of the
  // file AFTER the append wave — a write that lied counts as dead too.
  const rows = parseTerminalRows(await readFile(terminalsPath, "utf8").catch(() => ""));
  const dead = deadWithoutRecord([...COUNCILORS], rows);
  const effectiveVerdict = dead.length > 0 ? "CANNOT_ANSWER" : tally.verdict;

  const finalRecord: RunRecord = {
    ...record,
    status: "done",
    updatedAt: new Date().toISOString(),
    verdict: {
      verdict: effectiveVerdict,
      approvals: tally.approvals,
      rejects: tally.rejects,
      errors: tally.errors,
      missing: tally.missing,
    },
    instrument: instrumentFace(),
    independence,
    notes:
      `policy=${tally.policy} ${deadFaceCount(dead)}${dead.length > 0 ? ` (${dead.join(",")} left no terminal row: instrument wounded, not a verdict)` : ""} independence=${independence.status}${independence.status === "NOT-INDEPENDENT" ? " (self-convoked: ballot preserved, not in any effective path)" : ""} ` +
      outcomes.map((o) => `${o.id}=${ballotTag(o.vote)} reply=${o.replyPath}`).join(" · "),
  };
  await deps.store.appendOrUpdate(finalRecord);

  const lines: string[] = [
    `SIBYL CONSULT: ${effectiveVerdict} (${deadFaceCount(dead)} votes ${String(tally.approvals)}A/${String(tally.rejects)}R/${String(tally.errors)}E/${String(tally.missing)}M) run ${record.runId}`,
    `  ${independenceLabel(independence)}`,
    ...tally.reasons.map((r) => `  reason: ${r}`),
    ...tally.must_fix.map((m) => `  must_fix: ${m}`),
    ...outcomes.map((o) => `  reply: ${o.id} -> ${o.replyPath}`),
    `  ${rulesLabel(finalRecord.instrument ?? instrumentFace())} components=${String(Object.keys(instrumentFace().components).length)}`,
    `  store: ${deps.store.runsFile}`,
  ];
  return lines.join("\n");
}

function ballotTag(vote: CouncilVote): string {
  if ("missing" in vote) return "MISSING";
  return vote.ok ? vote.verdict.verdict : "ERROR";
}
