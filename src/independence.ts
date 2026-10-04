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

function scanMessages(rows: Msg[], convenerIndex: number, sid: string, artifact: ArtifactInput & { ok: true }): string | null {
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
  let scanFailed = "";
  for (const [i, sid] of chain.entries()) {
    const res = await client.session.messages({ path: { id: sid }, query: { directory } });
    if (res.error !== undefined || res.data === undefined) {
      scanFailed = scanFailed.length > 0 ? scanFailed : `messages(${sid}) refused`;
      continue;
    }
    const hit = scanMessages(res.data, i, sid, artifact);
    if (hit !== null) {
      return { status: "NOT-INDEPENDENT", convenerChain: chain, evidence: hit };
    }
  }
  if (scanFailed.length > 0 || walkIncomplete) {
    const why = [walkIncomplete ? walkReason : "", scanFailed].filter((s) => s.length > 0).join("; ");
    return { status: "UNVERIFIABLE", convenerChain: chain, evidence: `partial read: ${why} — independence was NOT established` };
  }
  const note = walkReason.length > 0 ? `; walk note: ${walkReason}` : "";
  return {
    status: "INDEPENDENT",
    convenerChain: chain,
    evidence: `scanned ${String(chain.length)} session(s) of the convener chain to root; no drafting evidence within read scope${note}`,
  };
}

/** Receipt-face rendering used by all three entries. */
export function independenceLabel(v: IndependenceVerdict): string {
  return v.status === "INDEPENDENT" ? "independence=INDEPENDENT" : `independence=${v.status} — ${v.evidence}`;
}
