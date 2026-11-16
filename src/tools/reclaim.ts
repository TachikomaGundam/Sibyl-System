// H1 anti-bloat reclaimer (council run sibyl-20261114T101952Z-d820, owner order
// 2026-11-14): process-internal persona sessions (consult votes, swarm
// planner/minter/workers/judge) must not accumulate as engine rows forever —
// they are the dominant growth source measured on the live store. This module
// deletes them AFTER their evidence is on disk, never touching the convener.
//
// Law (see docs design, must_fix map d820):
//  - REGISTERED-ONLY (I2): only ids created INSIDE the call (trackedClient
//    sink) are candidates. The convener row is never registered (it predates
//    the call) and follows the >=90d audit-receipt retention instead.
//  - EVIDENCE-FIRST (I1): SESSIONS.json + CHECKSUMS.txt are written (hashed,
//    read-back verified) BEFORE the first delete; every artifact path a
//    session is cited by must be readable or that session is skipped.
//  - FAILURE-CONSERVATIVE (I5): a failed delete never changes the run
//    verdict; it lands in DEAD-LETTER.jsonl, which
//    scripts/session-reap.mjs --manifest consumes as a machine recovery path.
//  - IDEMPOTENT (I5/must_fix 9): an engine "not found" answer means deleted.
// Deletion walks the LAST-created id first (reverse creation order) so an
// explicit parent row is never removed before its children.

import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EngineClient } from "../engine/index.ts";
import { errMessage } from "../util.ts";

export type SessionReclaimEntry = {
  /** engine session id created during the call */
  sessionId: string;
  /** artifacts this session is cited by; ALL must be readable to delete */
  artifactPaths: string[];
};

export type SessionReclaimOutcome = {
  ran: boolean;
  reason?: string;
  retainSessions: boolean;
  deleted: string[];
  skipped: { sessionId: string; reason: string }[];
  failed: { sessionId: string; reason: string }[];
};

/** EngineClient decorator recording every successfully created session id.
 * The shim is a plain data object (src/v2/adapter.ts), so spreading is safe. */
export function trackingClient(base: EngineClient, sink: Set<string>): EngineClient {
  return {
    ...base,
    session: {
      ...base.session,
      create: async (args) => {
        const res = await base.session.create(args);
        const id = res?.data?.id;
        if (typeof id === "string" && id !== "") sink.add(id);
        return res;
      },
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type RowState = "pending" | "deleted" | "skipped" | "failed";
type ManifestRow = {
  runKind: "reclaim";
  spaceDir: string;
  sessionId: string;
  artifacts: { path: string; sha256: string }[];
  deleted: boolean;
  state: RowState;
  reason?: string;
  at: string;
};

const NOT_FOUND = /not\s*found|unknown session|no such session/i;

/** Delete the registered sessions of one terminal, done run. Never throws. */
export async function reclaimRunSessions(opts: {
  /** the SAME client the call used (its delete reaches the same engine store) */
  client: EngineClient;
  directory: string;
  spaceDir: string;
  retainSessions: boolean;
  /** creation order in; deletion walks the array in reverse */
  entries: SessionReclaimEntry[];
  /** extra files hashed into CHECKSUMS.txt (TERMINALS.txt, reply files, ...) */
  evidencePaths: string[];
}): Promise<SessionReclaimOutcome> {
  const outcome: SessionReclaimOutcome = {
    ran: false,
    retainSessions: opts.retainSessions,
    deleted: [],
    skipped: [],
    failed: [],
  };
  if (opts.retainSessions) {
    outcome.reason = "retainSessions";
    return outcome;
  }
  if (opts.entries.length === 0) {
    outcome.ran = true;
    outcome.reason = "nothing-registered";
    return outcome;
  }
  if (opts.client.session.delete === undefined) {
    outcome.reason = "engine-delete-unavailable";
    outcome.skipped = opts.entries.map((e) => ({ sessionId: e.sessionId, reason: "engine-delete-unavailable" }));
    return outcome;
  }

  // ---- EVIDENCE-FIRST: hash artifacts + write SESSIONS.json, then verify ----
  const rows: ManifestRow[] = [];
  const keep: SessionReclaimEntry[] = [];
  for (const e of opts.entries) {
    const artifacts: { path: string; sha256: string }[] = [];
    let missing: string | undefined;
    for (const p of e.artifactPaths) {
      try {
        artifacts.push({ path: p, sha256: sha256(await readFile(p, "utf8")) });
      } catch {
        missing = p;
        break;
      }
    }
    if (missing !== undefined) {
      outcome.skipped.push({ sessionId: e.sessionId, reason: `evidence-missing:${missing}` });
      continue;
    }
    keep.push(e);
    rows.push({
      runKind: "reclaim",
      spaceDir: opts.spaceDir,
      sessionId: e.sessionId,
      artifacts,
      deleted: false,
      state: "pending",
      at: new Date().toISOString(),
    });
  }
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const settle = (id: string, state: RowState, reason?: string): void => {
    const row = byId.get(id);
    if (row === undefined) return;
    row.state = state;
    row.deleted = state === "deleted";
    if (reason !== undefined) row.reason = reason;
  };

  const sessionsPath = join(opts.spaceDir, "SESSIONS.json");
  const checksumsPath = join(opts.spaceDir, "CHECKSUMS.txt");
  try {
    await writeFile(sessionsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const allEvidence = [...opts.evidencePaths, sessionsPath];
    const lines: string[] = [];
    for (const p of allEvidence) {
      try {
        lines.push(`${sha256(await readFile(p, "utf8"))}  ${p}`);
      } catch {
        /* evidence listed but unreadable: CHECKSUMS covers what exists */
      }
    }
    await writeFile(checksumsPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
    const readBack = await readFile(sessionsPath, "utf8");
    if (readBack.split("\n").filter((l) => l.trim() !== "").length !== rows.length) {
      throw new Error("read-back row count mismatch");
    }
    await readFile(checksumsPath, "utf8");
  } catch (err) {
    outcome.reason = `evidence-write-failed:${errMessage(err)}`;
    outcome.skipped = opts.entries.map((e) => ({ sessionId: e.sessionId, reason: outcome.reason! }));
    return outcome;
  }

  // ---- DELETE, reverse creation order (explicit children first) ----
  const deadLetterPath = join(opts.spaceDir, "DEAD-LETTER.jsonl");
  for (const e of [...keep].reverse()) {
    try {
      const res = await opts.client.session.delete!({ path: { id: e.sessionId }, query: { directory: opts.directory } });
      if (res?.error !== undefined && res.error !== null) {
        const msg = errMessage(res.error);
        if (NOT_FOUND.test(msg)) {
          outcome.deleted.push(e.sessionId);
          settle(e.sessionId, "deleted", "already-absent");
        } else {
          outcome.failed.push({ sessionId: e.sessionId, reason: msg });
          settle(e.sessionId, "failed", msg);
        }
      } else {
        outcome.deleted.push(e.sessionId);
        settle(e.sessionId, "deleted");
      }
    } catch (err) {
      const msg = errMessage(err);
      outcome.failed.push({ sessionId: e.sessionId, reason: msg });
      settle(e.sessionId, "failed", msg);
    }
  }

  if (outcome.failed.length > 0) {
    try {
      await appendFile(
        deadLetterPath,
        outcome.failed.map((f) => JSON.stringify({ sessionId: f.sessionId, reason: f.reason, at: new Date().toISOString() })).join("\n") + "\n",
        "utf8",
      );
    } catch {
      /* dead-letter write failure is reported through the failed list itself */
    }
  }

  // rewrite the manifest with final states (evidence stays ahead of truth)
  try {
    await writeFile(sessionsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch {
    /* final-state rewrite is best-effort; the pending manifest remains valid */
  }

  outcome.ran = true;
  return outcome;
}
