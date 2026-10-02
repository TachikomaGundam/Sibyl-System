// provenance: g12b-8 remote time-source probe + g12b-4 ref-move attribution
// comparator (plan: Abathur loop/proposals/g12b-instruments-draft.md), clean-room.
//
// design discipline shared by both probes:
//  - PURE cores, injected I/O (fetch / parsed inputs) so vitest never touches network or git;
//  - closed verdict enums; missing data is never read as consent (fail-closed);
//  - independence is mechanical: two sources signed/owned by the SAME owner/dept
//    are ONE source (the double-mirror-of-one-master attack).

import { tool } from "@opencode-ai/plugin";
import { internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

// ── time probe ───────────────────────────────────────────────────────────────

export type TimeSource = { readonly url: string; readonly ownerDept: string };

export type ProbeReceipt = {
  readonly url: string;
  readonly ownerDept: string;
  readonly ok: boolean;
  readonly epochMs?: number | undefined;
  readonly error?: string | undefined;
};

export const DEFAULT_TIME_POOL: readonly TimeSource[] = [
  { url: "https://www.cloudflare.com", ownerDept: "cloudflare" },
  { url: "https://www.google.com", ownerDept: "google" },
  { url: "https://www.mozilla.org", ownerDept: "mozilla" },
];

/** Parse an HTTP-date Date header; reject everything else (no silent NaN). */
export function parseHttpDate(value: string | null): number | undefined {
  if (value === null) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export async function probeTimes(
  sources: readonly TimeSource[],
  fetchImpl: typeof fetch,
  timeoutMs = 8000,
): Promise<ProbeReceipt[]> {
  return await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await fetchImpl(s.url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        const ms = parseHttpDate(res.headers.get("date"));
        return ms === undefined
          ? { url: s.url, ownerDept: s.ownerDept, ok: false, error: "no-parseable-date-header" }
          : { url: s.url, ownerDept: s.ownerDept, ok: true, epochMs: ms };
      } catch (e) {
        return { url: s.url, ownerDept: s.ownerDept, ok: false, error: String(e).slice(0, 120) };
      }
    }),
  );
}

export type Consensus = {
  readonly verdict: "SYNCED" | "DRIFT" | "INSUFFICIENT-SOURCES";
  readonly usedUrls: readonly string[];
  readonly spreadMs: number;
  readonly localOffsetMs: number;
};

/** Consensus over >=2 DISTINCT ownerDepts; same-owner pairs collapse to one
 * source on purpose. tolerance: per-hop network slop accepted (default 5 min —
 * HTTP Date has second granularity but proxies add lag; tighten per contract). */
export function consensus(receipts: readonly ProbeReceipt[], localMs: number, toleranceMs = 300_000): Consensus {
  const ok = receipts.filter((r) => r.ok && r.epochMs !== undefined);
  const byDept = new Map<string, ProbeReceipt>();
  for (const r of ok) if (!byDept.has(r.ownerDept)) byDept.set(r.ownerDept, r);
  const used = [...byDept.values()];
  if (used.length < 2) {
    return { verdict: "INSUFFICIENT-SOURCES", usedUrls: used.map((u) => u.url), spreadMs: 0, localOffsetMs: 0 };
  }
  const times = used.map((u) => u.epochMs!);
  const spreadMs = Math.max(...times) - Math.min(...times);
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
  const localOffsetMs = localMs - median;
  const verdict = spreadMs <= toleranceMs && Math.abs(localOffsetMs) <= toleranceMs ? "SYNCED" : "DRIFT";
  return { verdict, usedUrls: used.map((u) => u.url), spreadMs, localOffsetMs };
}

// ── attribution comparator ───────────────────────────────────────────────────

export type RefMove = { readonly remote: string; readonly ref: string; readonly oldSha: string | null; readonly newSha: string };
export type CommitMeta = { readonly sha: string; readonly committerName: string; readonly committerEmail: string; readonly signedByKey: string | null };
export type RosterEntry = { readonly name: string; readonly email: string; readonly keyFingerprint?: string | undefined };

export type Attribution = {
  readonly verdict: "ATTRIBUTED" | "UNATTRIBUTED" | "AMBIGUOUS";
  readonly detail: string;
};

function equalBytes(a: string, b: string): boolean {
  return a === b; // closed normalization: NONE. bytes are bytes (identity gate law).
}

/** Attribute each ref move to its new commit's committer identity against the
 * roster. UNATTRIBUTED = the silent-egress case (move with no registered
 * identity behind it); AMBIGUOUS = roster itself contains a byte-equal pair for
 * this committer, which is a registry defect and blocks, never picks. */
export function attributeRange(moves: readonly RefMove[], commits: readonly CommitMeta[], roster: readonly RosterEntry[]): Attribution[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  return moves.map((m) => {
    const c = bySha.get(m.newSha);
    if (c === undefined) return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: new commit ${m.newSha.slice(0, 12)} not in supplied commit set` };
    const hits = roster.filter((r) => equalBytes(r.name, c.committerName) && equalBytes(r.email, c.committerEmail));
    if (hits.length === 0) return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: committer "${c.committerName} <${c.committerEmail}>" has no ACTIVE roster binding` };
    if (hits.length > 1) return { verdict: "AMBIGUOUS", detail: `${m.remote} ${m.ref}: ${hits.length} roster entries byte-equal — registry defect, needs human dedup workorder` };
    const hit = hits[0]!;
    if (c.signedByKey !== null && hit.keyFingerprint !== undefined && !equalBytes(c.signedByKey, hit.keyFingerprint)) {
      return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: signed by key ${c.signedByKey.slice(0, 12)} != roster binding ${hit.keyFingerprint.slice(0, 12)} (bytes-claim without signature)` };
    }
    return { verdict: "ATTRIBUTED", detail: `${m.remote} ${m.ref} -> ${hit.name} <${hit.email}>${hit.keyFingerprint !== undefined ? ` key=${hit.keyFingerprint.slice(0, 12)}` : ""}` };
  });
}

/** Parse `git log --format=%H|%cn|%ce|%GK` output (unsigned rows emit an empty key field). */
export function parseCommitMeta(stdout: string): CommitMeta[] {
  return stdout.split("\n").filter((l) => l.includes("|")).map((l) => {
    const [sha = "", committerName = "", committerEmail = "", gk = ""] = l.split("|");
    return { sha: sha.trim(), committerName: committerName ?? "", committerEmail: committerEmail ?? "", signedByKey: (gk ?? "").trim() === "" ? null : (gk ?? "").trim() };
  });
}

// ── tool surface ─────────────────────────────────────────────────────────────

export const TIME_PROBE_TOOL_NAME = "sibyl_time_probe";
export const ATTRIBUTE_TOOL_NAME = "sibyl_attribute";

export function buildTimeProbeTool(deps: ToolDeps) {
  void deps;
  return tool({
    description:
      "SIBYL time probe (g12b-8): read HTTP Date headers from >=2 operator-distinct remote sources and compare " +
      "against the local clock — verdict SYNCED / DRIFT / INSUFFICIENT-SOURCES with spread and offset in ms. " +
      "Same-owner sources collapse to one; fewer than two distinct owners can NEVER certify time.",
    args: {
      endpoints: tool.schema.string().optional().describe("JSON array of {url,ownerDept}; defaults to the built-in cloudflare/google/mozilla pool."),
      toleranceMs: tool.schema.number().int().positive().optional().describe("Accepted spread/offset in ms (default 300000 = 5 min, HTTP-date + proxy slop)."),
    },
    execute: async (args, _context: ToolContextLike) => {
      try {
        const sources: readonly TimeSource[] = args.endpoints !== undefined ? JSON.parse(args.endpoints) as TimeSource[] : DEFAULT_TIME_POOL;
        const receipts = await probeTimes(sources, fetch);
        const c = consensus(receipts, Date.now(), args.toleranceMs);
        return [
          `SIBYL TIME ${c.verdict}`,
          `used=${c.usedUrls.join(",")}`,
          `spread_ms=${c.spreadMs} local_offset_ms=${c.localOffsetMs} tolerance_ms=${args.toleranceMs ?? 300000}`,
          ...receipts.map((r) => `${r.ok ? "ok" : "fail"} ${r.url} (${r.ownerDept})${r.error !== undefined ? ` — ${r.error}` : ` — ${new Date(r.epochMs ?? 0).toISOString()}`}`),
        ].join("\n");
      } catch (e) {
        return internalError("sibyl_time_probe", e);
      }
    },
  });
}

export function buildAttributeTool(deps: ToolDeps) {
  void deps;
  return tool({
    description:
      "SIBYL attribution (g12b-4): compare supplied ref moves (remote/ref/old/new) against commit metadata and a " +
      "roster (identity+key bindings, ACTIVE entries) — per-move verdict ATTRIBUTED / UNATTRIBUTED / AMBIGUOUS. " +
      "Byte-exact comparison, no normalization; unknown commits and missing bindings are UNATTRIBUTED (silent " +
      "egress is fatal-class), byte-equal roster duplicates are AMBIGUOUS registry defects. Inputs are read-only " +
      "strings the CALLER captured (git log / ls-remote output) — this tool never shells out.",
    args: {
      moves: tool.schema.string().describe("JSON array of {remote,ref,oldSha,newSha}."),
      commits: tool.schema.string().describe("`git log --format=%H|%cn|%ce|%GK` output covering the moved-to commits (newest first or any order)."),
      roster: tool.schema.string().describe("JSON array of {name,email,keyFingerprint?} — the registered identity bindings."),
    },
    execute: async (args) => {
      try {
        const moves = JSON.parse(args.moves) as RefMove[];
        const roster = JSON.parse(args.roster) as RosterEntry[];
        const commits = parseCommitMeta(args.commits);
        const results = attributeRange(moves, commits, roster);
        const head = results.every((r) => r.verdict === "ATTRIBUTED") ? "ALL ATTRIBUTED"
          : results.some((r) => r.verdict === "UNATTRIBUTED") ? "UNATTRIBUTED MOVES PRESENT (fatal class)"
          : "AMBIGUOUS — registry defect";
        return [`SIBYL ATTRIBUTE: ${head}`, ...results.map((r) => `${r.verdict} :: ${r.detail}`)].join("\n");
      } catch (e) {
        return internalError("sibyl_attribute", e);
      }
    },
  });
}
