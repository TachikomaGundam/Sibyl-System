// provenance: original clean-room Sibyl-System implementation (v1.1 lane layer),
// no external code copied. E4 seating prefilter + E2 judge draw.
//
// F1 lesson encoded: cloud seats burned real reps on 403 mid-campaign because
// selection was provider-luck, not policy. Here the DENY is computed at
// resolveSeat time from a declared local-model policy — the caller must refuse
// the spawn itself; a denied seat never reaches the launcher.
//
// E2 lesson encoded: the judge seat is drawn from a pool with a seed that is
// COMMITTED (drawCommit hash) before the candidate/round sessions launch, and
// the draw is deterministic — same pool+seed+salt replays the same seat, so an
// auditor can re-derive it from the run record alone.
//
// Zero imports from options/swarm: this module is a leaf (its own structural
// ModelSlot twin) so any layer can depend on it without cycles.

import { createHash } from "node:crypto";

/** Structural model pair (options.ModelSlot / swarm ModelSlot twin). */
export type SeatModel = { providerID: string; modelID: string };

/** Pool of named slots; caller guarantees lookup semantics (see resolveSeat). */
export type SeatPool = Readonly<Record<string, SeatModel>>;

/** E4 policy: a model id may run only if it starts with one of the prefixes. */
export type SeatPolicy = { readonly allowedPrefixes: readonly string[] };

export type SeatDecision =
  | { ok: true; role: string; slot: string; modelId: string }
  | { ok: false; role: string; deny: string };

/** "provider/model" — the single string form recorded and policy-checked. */
export function toModelId(model: SeatModel): string {
  return `${model.providerID}/${model.modelID}`;
}

/** True iff modelId starts with some non-empty allowed prefix. */
export function policyAllows(modelId: string, policy: SeatPolicy): boolean {
  return policy.allowedPrefixes.some((prefix) => prefix.length > 0 && modelId.startsWith(prefix));
}

/**
 * Resolve one seat through the chain requestedSlot -> "default" -> DENY, then
 * apply the E4 policy. Every miss is a structured deny (never throws):
 *  - no slot entry at all,
 *  - the unconfigured placeholder (empty provider AND model),
 *  - policy miss ("not under any allowed prefix" — dispatch-time DENY, F1).
 */
export function resolveSeat(
  role: string,
  requestedSlot: string,
  pool: SeatPool,
  policy: SeatPolicy,
): SeatDecision {
  const found = pool[requestedSlot] ?? pool["default"];
  if (found === undefined) {
    return {
      ok: false,
      role,
      deny: `seat denied: slot "${requestedSlot}" (and fallback "default") absent from pool`,
    };
  }
  const modelId = toModelId(found);
  if (found.providerID.length === 0 || found.modelID.length === 0) {
    return { ok: false, role, deny: `seat denied: slot "${requestedSlot}" is an empty placeholder (${modelId})` };
  }
  if (!policyAllows(modelId, policy)) {
    return {
      ok: false,
      role,
      deny:
        `seat denied by modelPolicy (E4/F1): "${modelId}" is not under any allowed prefix ` +
        `[${policy.allowedPrefixes.join(", ")}] — launch must not be attempted`,
    };
  }
  return { ok: true, role, slot: requestedSlot, modelId };
}

const SEP = "\u001f"; // unit separator — deterministic join for hashing

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * C-05 draw-commit: sha256 over the ordered pool ids + seed. Recorded in the
 * run record BEFORE any candidate/round launch; a later claim of a different
 * pool or seed contradicts the commit (loud, mechanically checkable).
 */
export function computeDrawCommit(poolIds: readonly string[], seed: string): string {
  return sha256Hex(`sibyl-draw-v1${SEP}${poolIds.join(SEP)}${SEP}${seed}`);
}

export type JudgeDraw = { index: number; modelId: string; drawCommit: string };

/**
 * Deterministic judge-seat draw: uint32(sha256(drawCommit||salt)) % pool size.
 * Empty pool is a structured deny — there is no default judge.
 */
export function drawJudge(
  poolIds: readonly string[],
  seed: string,
  salt: string,
): { ok: true; draw: JudgeDraw } | { ok: false; deny: string } {
  if (poolIds.length === 0) {
    return { ok: false, deny: "judge draw denied: empty judge pool" };
  }
  const drawCommit = computeDrawCommit(poolIds, seed);
  const digest = sha256Hex(`${drawCommit}${SEP}${salt}`);
  const uint = Number.parseInt(digest.slice(0, 8), 16); // 32 bits, exact in doubles
  const index = uint % poolIds.length;
  const modelId = poolIds[index] as string;
  return { ok: true, draw: { index, modelId, drawCommit } };
}
