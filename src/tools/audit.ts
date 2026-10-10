// provenance: sibyl_audit primitive (owner "继续进化" 2026-10-09/10 on the closed
// accountability arc 526d REJECT -> corrections -> independent audit 13/13 -> 79d6
// APPROVE). That arc ran through a human-launched e2e script; the constitution
// (L-STATE-ATOMIC: completion state rides only blind-audit or key-holder receipts;
// L-BLIND-AUDIT: auditor identity must sit outside the producing chain) says the
// outside lane must be a PRODUCT organ. It is now: the convener of an audit is a
// FRESH ENGINE-PROVISIONED ROOT SESSION — structurally impossible to be kin to any
// drafting chain, because it did not exist until the audit began. The caller's own
// session id is recorded as DATA (requested-by) and plays no part in the ballot.

import { createHash } from "node:crypto";

import { tool } from "@opencode-ai/plugin";

import { consultExecute } from "./consult.ts";
import { internalError, readArtifact } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const AUDIT_TOOL_NAME = "sibyl_audit";

const RUN_ID_RE = /run (sibyl-[0-9TZ-]+-[0-9a-f]+)/;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** True when the artifact bytes changed while the ballot was in flight —
 * an audit receipt binds to bytes, and bytes that move bind to nothing. */
async function artifactHash(raw: string, dir: string): Promise<string | null> {
  const art = await readArtifact(raw, dir);
  return art.ok ? sha256(art.text) : null;
}

export function buildAuditTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL independent audit lane: convenes the three-councilor consult from a FRESH engine-provisioned " +
      "root session (structurally non-kin to any drafting chain), so the ballot enters the effective path " +
      "without the caller's identity touching it. Emits an audit receipt — auditor session id (retained, " +
      "DB-reconcilable), artifact sha256 bound at start and end, verdict face. REFUSES (no receipt) if the " +
      "fresh convener resolves to anything but INDEPENDENT, or the artifact drifts mid-ballot (VOID).",
    args: {
      artifact: tool.schema.string().min(1).describe("Path to the artifact, or its inline content (multi-line)."),
      goal: tool.schema.string().min(1).describe("The question the audit must answer."),
    },
    execute: async (args, context) => {
      try {
        return await auditExecute(deps, args, context);
      } catch (err) {
        return internalError(AUDIT_TOOL_NAME, err);
      }
    },
  });
}

/** Testable core behind the tool wrapper (same signature the host drives). */
export async function auditExecute(
  deps: ToolDeps,
  args: { artifact: string; goal: string },
  ctx: ToolContextLike,
): Promise<string> {
  const start = await readArtifact(args.artifact, ctx.directory);
  if (!start.ok) {
    return `SIBYL AUDIT: refused — artifact unreadable: ${start.error}`;
  }
  const shaStart = sha256(start.text);

  const created = await deps.client.session.create({
    body: { title: `sibyl:audit ${new Date().toISOString()}` },
    query: { directory: ctx.directory },
  });
  const auditor = created.data?.id ?? "";
  if (auditor.length === 0) {
    const why = created.error === undefined ? "no id in response" : JSON.stringify(created.error).slice(0, 140);
    return `SIBYL AUDIT: refused — engine did not provision the fresh root convener (${why}); an audit without a resolvable auditor session is not an audit`;
  }
  const caller = ctx.sessionID.length > 0 ? ctx.sessionID : "headless";

  const ballot = await consultExecute(deps, args, { ...ctx, sessionID: auditor });
  const runId = RUN_ID_RE.exec(ballot)?.[1] ?? "";
  const runs = await deps.store.load();
  const rec = runs.find((r) => r.runId === runId);

  const ind = rec?.independence;
  const independence = ind?.status ?? "MISSING-RECORD";
  if (independence !== "INDEPENDENT") {
    const ev = ind?.evidence ?? `run ${runId.length > 0 ? runId : "(unresolvable)"} not found in the store`;
    return (
      `SIBYL AUDIT: REFUSED — the fresh convener ${auditor} resolved to independence=${independence}: ${ev}\n` +
      `  the ballot ${runId.length > 0 ? runId : "(no run id)"} is archived as DATA and carries no audit receipt; ` +
      "requested-by=" + caller + " (DATA only)"
    );
  }

  const shaEnd = await artifactHash(args.artifact, ctx.directory);
  if (shaEnd !== shaStart) {
    return (
      `SIBYL AUDIT: VOID — artifact bytes moved while the ballot was in flight ` +
      `(start sha256 ${shaStart.slice(0, 16)}…, end ${shaEnd === null ? "unreadable" : `${shaEnd.slice(0, 16)}…`}); ` +
      `run ${runId} archived as DATA; re-audit the current bytes`
    );
  }

  const v = rec?.verdict;
  const counts = v === undefined ? "no verdict" : `${String(v.approvals)}A/${String(v.rejects)}R/${String(v.errors)}E/${String(v.missing)}M`;
  const rules = rec?.instrument?.rulesHash.slice(0, 12) ?? "no-instrument-face";
  return (
    [
      `SIBYL AUDIT RECEIPT run=${runId}`,
      `  verdict=${v?.verdict ?? "unknown"} (${counts}) rules=${rules}`,
      `  auditor-convener=${auditor} (fresh engine-provisioned root; session row RETAINED for DB reconciliation)`,
      `  requested-by=${caller} — recorded as ledger data only; it neither convenes nor votes`,
      `  artifact-sha256=${shaStart} (re-hashed after the ballot, identical — the receipt binds to these bytes)`,
      "",
      "--- ballot face ---",
      ballot,
    ].join("\n")
  );
}
