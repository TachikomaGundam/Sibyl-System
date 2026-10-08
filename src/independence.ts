// provenance: W1 convener-recusal law (handoff HANDOFF-SIBYL-20261004.md;
// prototypes: 28 USC §455(b)(3) — a judge with a personal relation must
// recuse; the audit-general is independent of the ministry audited).
//
// The incident this kills: the v1-charter review (run sibyl-20261004T103040Z-
// 91fc) was convened BY the drafting chain of the artifact it reviewed. Its
// own first principle would grade that ballot as a self-check — yet the
// instrument accepted it as an independent verdict. A party must not choose
// its own court, and the machine must refuse the kinship itself.
//
// Method (mechanical, engine-store-backed, no self-report):
//   1. walk the convener chain: the calling session and every ancestor via
//      client.session.get (parentID links resolved by the ENGINE, reconcilable
//      against its DB from an isolated session);
//   2. scan each chain member's messages for drafting evidence of the artifact:
//      a write/edit tool part targeting the artifact path, or content matching
//      the inline artifact (>= MIN_INLINE_MATCH chars, exact-after-trim or
//      containment, plus the assistant-text leg where the author pasted it);
//   2b. v2 content lineage (F-W1a/F-W1c, live miss: ballot 526d judged a
//      receipt INDEPENDENT that its convener chain had authored verbatim under
//      a different checkout path, plus heredoc drafts): sample verbatim
//      256-byte windows of a path artifact and match them against write-tool
//      content AND shell argv within the chain, gated to parts that predate
//      the artifact's mtime — a part after mtime only ever copied FROM the
//      file, and copying is not drafting. Conviction needs a majority of the
//      sampled windows (template boilerplate matches a few windows, never a
//      majority; the ratio is exported for the tests to lock).
//   3. a hit on any chain member => NOT-INDEPENDENT. No hit within the read
//      scope => INDEPENDENT. A chain/content read that CANNOT be made =>
//      UNVERIFIABLE (never silently INDEPENDENT — absence-of-evidence is not
//      evidence-of-independence; the field itself must be present, the
//      missing-field-is-violation rule of the digest §three.2).

import type { EngineClient } from "./engine/index.ts";
import { INDEPENDENCE_STATUSES, type IndependenceStatusTag } from "./state/record.ts";
import type { ArtifactInput } from "./tools/shared.ts";

// The status vocabulary lives in the storage schema (record.ts); re-exported
// here so law-side consumers and the record layer can never drift apart.
export { INDEPENDENCE_STATUSES };
export type IndependenceStatus = IndependenceStatusTag;

export type IndependenceVerdict = {
  status: IndependenceStatus;
  /** Session ids from the convener (self) to the last resolved ancestor. */
  convenerChain: string[];
  evidence: string;
};

/** Ancestry walk cap: real chains are 1-3 deep; the cap only bounds a
 * pathological store, and the walk stops early on cycle detection. */
export const MAX_CHAIN_DEPTH = 16;

/** Inline artifacts shorter than this cannot prove authorship by content
 * (a one-line snippet matches everything; false-positives poison the law). */
export const MIN_INLINE_MATCH = 64;

/** The tool names that WRITE artifact bytes. Anything else is read/noise. */
const DRAFTING_TOOLS = ["write", "edit", "multiedit", "patch", "apply_patch"] as const;

const PATH_KEYS = ["filePath", "path"] as const;
const CONTENT_KEYS = ["content", "text", "oldString", "newString"] as const;

type Msg = NonNullable<NonNullable<Awaited<ReturnType<NonNullable<EngineClient["session"]["messages"]>>>["data"]>[number]>;

function isDraftingTool(name: string | undefined): boolean {
  return name !== undefined && (DRAFTING_TOOLS as readonly string[]).includes(name);
}

function pathTargets(input: Record<string, unknown> | undefined, artifactPath: string): boolean {
  if (input === undefined) return false;
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim() === artifactPath) return true;
  }
  return false;
}

function contentMatches(input: Record<string, unknown> | undefined, needle: string): boolean {
  if (input === undefined) return false;
  for (const key of CONTENT_KEYS) {
    const v = input[key];
    if (typeof v !== "string") continue;
    if (v.trim() === needle) return true;
    if (needle.length >= MIN_INLINE_MATCH && v.includes(needle)) return true;
    if (needle.length >= MIN_INLINE_MATCH && v.length >= MIN_INLINE_MATCH && needle.includes(v.trim()) && v.trim().length > 0) {
      return true; // the session wrote a superset file containing the inline artifact
    }
  }
  return false;
}

/** Shell tools: argv carries heredoc/inline drafts verbatim (F-W1a family). */
const SHELL_TOOLS = ["bash"] as const;
const SHELL_KEYS = ["command"] as const;

/** Verbatim window a lineage claim demands, and how many the artifact yields. */
export const LINEAGE_CHUNK = 256;
export const LINEAGE_SAMPLES = 32;
/** Fraction of sampled windows that must be found to convict (tests lock it). */
export const LINEAGE_UNION_RATIO = 0.6;
/** Below this many windows no fair majority exists — leg stays silent. */
export const LINEAGE_MIN_WINDOWS = 3;

type Lineage = {
  chunks: string[];
  need: number;
  mtimeMs: number;
  matched: Map<number, string>;
  copiedAfterMtime: number;
  timeless: number;
};

function sampleWindows(text: string): string[] {
  const total = Math.floor(text.length / LINEAGE_CHUNK);
  if (total < LINEAGE_MIN_WINDOWS) return [];
  const step = Math.max(1, Math.floor(total / LINEAGE_SAMPLES));
  const out: string[] = [];
  for (let i = 0; i < total; i += step) out.push(text.slice(i * LINEAGE_CHUNK, (i + 1) * LINEAGE_CHUNK));
  return out.slice(0, LINEAGE_SAMPLES);
}

function beginLineage(artifact: ArtifactInput & { ok: true }): Lineage | null {
  if (artifact.kind !== "path" || artifact.mtimeMs === undefined) return null;
  const chunks = sampleWindows(artifact.text);
  if (chunks.length < LINEAGE_MIN_WINDOWS) return null;
  return {
    chunks,
    need: Math.max(2, Math.ceil(chunks.length * LINEAGE_UNION_RATIO)),
    mtimeMs: artifact.mtimeMs,
    matched: new Map(),
    copiedAfterMtime: 0,
    timeless: 0,
  };
}

function messageTime(m: Msg): number | undefined {
  const t = (m.info as { time?: { created?: number } } | undefined)?.time?.created;
  return typeof t === "number" ? t : undefined;
}

function partCandidates(p: { tool?: string; input?: Record<string, unknown> }): string[] {
  const shell = p.tool !== undefined && (SHELL_TOOLS as readonly string[]).includes(p.tool);
  if (!shell && !isDraftingTool(p.tool)) return [];
  const keys: readonly string[] = shell ? SHELL_KEYS : CONTENT_KEYS;
  const out: string[] = [];
  for (const key of keys) {
    const v = p.input?.[key];
    if (typeof v === "string" && v.length >= LINEAGE_CHUNK) out.push(v);
  }
  return out;
}

function lineageVerdict(lg: Lineage, artifact: ArtifactInput & { ok: true }): string {
  const sources = [...new Set([...lg.matched.values()])].slice(0, 3).join("; ");
  return (
    `content-lineage evidence: ${String(lg.matched.size)} of ${String(lg.chunks.length)} verbatim ` +
    `${String(LINEAGE_CHUNK)}-byte windows of ${artifact.source} appear in convener-chain tool inputs ` +
    `that predate its mtime (${sources}) — the chain authored this artifact's bytes before/independently ` +
    `of this path`
  );
}
function scanMessages(
  rows: Msg[],
  convenerIndex: number,
  sid: string,
  artifact: ArtifactInput & { ok: true },
  lg: Lineage | null,
): string | null {
  for (const [mi, m] of rows.entries()) {
    for (const p of m.parts ?? []) {
      if (p.type === "tool" && isDraftingTool(p.tool)) {
        if (artifact.kind === "path" && pathTargets(p.input, artifact.source)) {
          return `drafting evidence: ${p.tool} on ${artifact.source} in convener-chain session ${sid} (chain position ${String(convenerIndex)}, message ${String(mi)})`;
        }
        if (artifact.kind === "inline" && contentMatches(p.input, artifact.text.trim())) {
          return `drafting evidence: ${p.tool} content matches the inline artifact in convener-chain session ${sid} (chain position ${String(convenerIndex)}, message ${String(mi)})`;
        }
      }
      // the author pasting the inline text into their own chat counts too
      if (
        artifact.kind === "inline" &&
        m.info?.role === "assistant" &&
        p.type === "text" &&
        typeof p.text === "string" &&
        artifact.text.trim().length >= MIN_INLINE_MATCH &&
        p.text.includes(artifact.text.trim())
      ) {
        return `drafting evidence: assistant text in convener-chain session ${sid} (chain position ${String(convenerIndex)}, message ${String(mi)}) contains the inline artifact`;
      }
      if (p.type === "tool" && lg !== null) {
        const t = messageTime(m);
        if (t === undefined) {
          lg.timeless += 1;
          continue; // no timestamp => precedence unprovable => never credited
        }
        if (t > lg.mtimeMs) {
          lg.copiedAfterMtime += 1;
          continue; // after the artifact's last edit a part only ever copies FROM it
        }
        const label = `${p.tool ?? "tool"}@${sid}:${String(mi)}`;
        for (const cand of partCandidates(p)) {
          if (artifact.kind === "path" && cand.includes(artifact.text.trim())) {
            return `${lineageVerdict({ ...lg, matched: new Map([[0, label]]) }, artifact)}; full-text containment in ${label}`;
          }
          for (const [wi, chunk] of lg.chunks.entries()) {
            if (!lg.matched.has(wi) && cand.includes(chunk)) lg.matched.set(wi, label);
          }
        }
      }
    }
  }
  return null;
}

/**
 * Assess whether the convening execution chain is kin to the artifact's
 * drafting. Never throws: every unreadable surface yields UNVERIFIABLE with
 * the named reason (the receipt face then says plainly what could not be
 * checked). Engine-side identity (parentID) is the only accepted proof of
 * kinship — titles, self-reports and argv are DATA, never evidence.
 */
export async function assessIndependence(
  client: EngineClient,
  directory: string,
  convenerSessionID: string,
  artifact: ArtifactInput,
): Promise<IndependenceVerdict> {
  const noChain: IndependenceVerdict = { status: "UNVERIFIABLE", convenerChain: [], evidence: "" };
  if (convenerSessionID.length === 0) {
    return { ...noChain, evidence: "headless invocation: no calling session to resolve the convener chain against" };
  }
  if (!artifact.ok) {
    return { ...noChain, evidence: "artifact unreadable at assessment time" };
  }
  if (client.session.get === undefined) {
    return { ...noChain, evidence: "engine client exposes no session.get seam (chain cannot be walked; not a verdict of independence)" };
  }
  if (client.session.messages === undefined) {
    return { ...noChain, convenerChain: [convenerSessionID], evidence: "engine client exposes no session.messages seam (drafting scan impossible)" };
  }

  // 1. chain walk (engine-resolved parentID, cycle-capped)
  const chain: string[] = [convenerSessionID];
  const seen = new Set<string>(chain);
  let walkIncomplete = false;
  let walkReason = "";
  let current = convenerSessionID;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    const res = await client.session.get({ path: { id: current } });
    if (res.error !== undefined || res.data === undefined) {
      walkIncomplete = true;
      walkReason = `session.get(${current}) refused (${res.error === undefined ? "no data" : JSON.stringify(res.error).slice(0, 120)})`;
      break;
    }
    const parent = res.data.parentID ?? "";
    if (parent.length === 0) break; // root reached — chain complete
    if (seen.has(parent)) {
      walkReason = `cycle at ${parent} (store anomaly); walk stopped`;
      break;
    }
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }

  // 2. drafting scan across every resolved chain member
  const lg = beginLineage(artifact);
  let scanFailed = "";
  for (const [i, sid] of chain.entries()) {
    const res = await client.session.messages({ path: { id: sid }, query: { directory } });
    if (res.error !== undefined || res.data === undefined) {
      scanFailed = scanFailed.length > 0 ? scanFailed : `messages(${sid}) refused`;
      continue;
    }
    const hit = scanMessages(res.data, i, sid, artifact, lg);
    if (hit !== null) {
      return { status: "NOT-INDEPENDENT", convenerChain: chain, evidence: hit };
    }
  }
  if (lg !== null && lg.matched.size >= lg.need) {
    return { status: "NOT-INDEPENDENT", convenerChain: chain, evidence: lineageVerdict(lg, artifact) };
  }
  if (scanFailed.length > 0 || walkIncomplete) {
    const why = [walkIncomplete ? walkReason : "", scanFailed].filter((s) => s.length > 0).join("; ");
    return { status: "UNVERIFIABLE", convenerChain: chain, evidence: `partial read: ${why} — independence was NOT established` };
  }
  const note = walkReason.length > 0 ? `; walk note: ${walkReason}` : "";
  const lineageNote = lineageFaceNote(lg);
  return {
    status: "INDEPENDENT",
    convenerChain: chain,
    evidence: `scanned ${String(chain.length)} session(s) of the convener chain to root; no drafting evidence within read scope${lineageNote}${note}`,
  };
}

/** What the clean verdict must confess about the lineage leg it ran. */
function lineageFaceNote(lg: Lineage | null): string {
  if (lg === null) return "";
  const parts = [`${String(lg.matched.size)}/${String(lg.chunks.length)} lineage windows matched (need ${String(lg.need)})`];
  if (lg.copiedAfterMtime > 0) parts.push(`${String(lg.copiedAfterMtime)} part(s) excluded as post-mtime copies`);
  if (lg.timeless > 0) parts.push(`${String(lg.timeless)} part(s) lacked timestamps`);
  return `; content-lineage: ${parts.join(", ")}`;
}

/** Receipt-face rendering used by all three entries. */
export function independenceLabel(v: IndependenceVerdict): string {
  return v.status === "INDEPENDENT" ? "independence=INDEPENDENT" : `independence=${v.status} — ${v.evidence}`;
}
