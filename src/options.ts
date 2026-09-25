// provenance: original clean-room Sibyl-System implementation (plan task 6), no swarm code copied.
//
// PluginOptions: zod v4 schema + defaults for the SIBYL plugin config, and
// `parseOptions` which is FAIL-SOFT by contract. This module configures a
// plugin whose load-time throw = silent failure in the host, so parseOptions
// returns a structured Result union and NEVER throws - even for hostile input
// (zod v4 safeParse itself can rethrow throwing-getter traps, hence the outer
// try/catch proven necessary by .omo/evidence/t6/zod-probe2.mjs).
//
// zod here is INTERNAL parsing only (learnings.md #17 dual-instance rule):
// tool `args` schemas in T8 must use tool.schema.*, never this instance.

import { z } from "zod";

/** Default model-pool slot name every persona falls back to. */
export const DEFAULT_SLOT = "default";

/** Engine parity: same 240s default as src/engine/index.ts DEFAULT_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 240_000;

/** One model-pool entry: a concrete provider/model pair. */
export const modelSlotSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});
export type ModelSlot = z.infer<typeof modelSlotSchema>;

/**
 * Pool schema helper: arbitrary slot names -> model pairs, with the "default"
 * entry REQUIRED (missing default -> ok:false; the fallback must always exist).
 */
export const modelPoolSchema = z
  .object({ default: modelSlotSchema })
  .catchall(modelSlotSchema);
export type ModelPool = z.infer<typeof modelPoolSchema>;

const DEFAULT_POOL: ModelPool = { default: { providerID: "", modelID: "" } };

const slotName = z.string().min(1);

/** Per-councilor voter model slots (keys = councilor ids from src/council). */
export const voterSlotsSchema = z
  .object({
    MELCHIOR: slotName.default(DEFAULT_SLOT),
    BALTHASAR: slotName.default(DEFAULT_SLOT),
    CASPER: slotName.default(DEFAULT_SLOT),
  })
  .prefault({});
export type VoterSlots = z.infer<typeof voterSlotsSchema>;

/** Swarm-layer model slots (adversarial-swarm judge/pro/con roles). */
export const swarmSlotsSchema = z
  .object({
    judge: slotName.default(DEFAULT_SLOT),
    pro: slotName.default(DEFAULT_SLOT),
    con: slotName.default(DEFAULT_SLOT),
  })
  .prefault({});
export type SwarmSlots = z.infer<typeof swarmSlotsSchema>;

// Top level is STRICT on purpose: the host passes the registration tuple's second
// element VERBATIM as this object (SDK `Plugin = (input, options?: PluginOptions)`),
// so option fields live at the TOP LEVEL. A nested `{ options: {...} }` wrapper or a
// typo'd key must fail LOUD (ok:false -> DISABLED banner naming the key), never be
// silently ignored and run on defaults.
export const pluginOptionsSchema = z
  .object({
  /** voter model slot per councilor (each defaults to "default") */
  voters: voterSlotsSchema,
  /** judge/pro/con model slots for the swarm layer (each defaults to "default") */
  swarm: swarmSlotsSchema,
  /** refinement rounds cap; integer 1..16 */
  maxRounds: z.number().int().min(1).max(16).default(4),
  /** per-persona-call budget in ms; integer > 0 (engine DEFAULT_TIMEOUT_MS parity) */
  timeoutMs: z.number().int().min(1).default(DEFAULT_TIMEOUT_MS),
  /** parallel task width for architect workflows; integer 1..8 */
  concurrencyK: z.number().int().min(1).max(8).default(4),
  /** launch stagger between parallel persona calls, ms; integer >= 0 */
  staggerMs: z.number().int().min(0).default(2000),
  /** slot-name -> model pool; "default" entry is mandatory. prefault (not
   * default) so every parse returns a FRESH pool - zod's .default() hands back
   * the same shared object reference and a caller mutation would poison all
   * later parses (proved: .omo/evidence/t6/zod-probe3.mjs). */
  modelPool: modelPoolSchema.prefault(DEFAULT_POOL),
  /** v1.1 isolated-lane mechanics (src/lane/isolated.ts). configSource is
   * READ-COPIED into each role home (never written back). */
  lane: z
    .object({
      runRoot: z.string().min(1).default("/tmp"),
      opencodeBin: z.string().min(1).default("<home>/.local/bin/opencode"),
      configSource: z.string().default("<home>/.config/opencode/opencode.jsonc"),
      roleTimeoutMs: z.number().int().min(5_000).default(600_000),
    })
    .prefault({}),
  /** v1.1 E4/F1: seats only from allowed model-id prefixes; deny at launch. */
  modelPolicy: z
    .object({
      allowedPrefixes: z.array(z.string().min(1)).min(1).default(["local-"]),
    })
    .prefault({}),
  /** v1.1 chamber (democratic-centralism review engine) seat slots + rounds. */
  chamber: z
    .object({
      maxRounds: z.number().int().min(1).max(8).default(3),
      roles: z
        .object({
          evidence: slotName.default(DEFAULT_SLOT),
          pro: slotName.default(DEFAULT_SLOT),
          con: slotName.default(DEFAULT_SLOT),
          judge: slotName.default(DEFAULT_SLOT),
        })
        .prefault({}),
      /** slot names the judge may be drawn from (E2 pool + seed commit). */
      judgePool: z.array(slotName).min(1).default([DEFAULT_SLOT]),
    })
    .prefault({}),
})
  .strict();
export type PluginOptions = z.infer<typeof pluginOptionsSchema>;

/** Result union - ok:false carries human-readable, field-pathed messages. */
export type ParseOptionsResult =
  | { ok: true; options: PluginOptions }
  | { ok: false; errors: string[] };

type ReadableIssue = { readonly path: readonly PropertyKey[]; readonly message: string };

function formatIssue(issue: ReadableIssue): string {
  const path = issue.path.map((segment) => String(segment)).join(".") || "<root>";
  return `${path}: ${issue.message}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse untrusted plugin config into fully-defaulted PluginOptions.
 * Absent config (undefined) means "all defaults". Any other invalid input -
 * including objects whose property getters throw - yields ok:false with
 * readable errors. NEVER throws.
 */
export function parseOptions(raw: unknown): ParseOptionsResult {
  const input: unknown = raw === undefined ? {} : raw;
  try {
    const parsed = pluginOptionsSchema.safeParse(input);
    if (parsed.success) {
      return { ok: true, options: parsed.data };
    }
    return { ok: false, errors: parsed.error.issues.map(formatIssue) };
  } catch (err) {
    return {
      ok: false,
      errors: [`options threw during parsing and was rejected: ${describeError(err)}`],
    };
  }
}
