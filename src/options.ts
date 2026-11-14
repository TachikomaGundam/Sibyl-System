// provenance: original clean-room Sibyl-System implementation (plan task 6), no swarm code copied.
//
// PluginOptions: zod v4 schema + defaults for the SIBYL plugin config, and
// `parseOptions` which is FAIL-SOFT by contract. This module configures a
// plugin whose load-time throw = silent failure in the host, so parseOptions
// returns a structured Result union and NEVER throws - even for hostile input
// (zod v4 safeParse itself can rethrow throwing-getter traps, hence the outer
// try/catch proven necessary by a dev-time probe, archived outside this repo).
//
// zod here is INTERNAL parsing only (V1-era dual-instance learning #17; under
// V2 the tool input schemas in src/tools/define.ts deliberately hand OUR
// bundled instance to the host as StandardSchemaV1 — duck-typed across realms).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { errMessage } from "./util.ts";

/** Default model-pool slot name every persona falls back to. */
export const DEFAULT_SLOT = "default";

/** THE single definition of the per-persona-call budget default (v1.5.0
 * L-SINGLE-SOURCE): engine and swarm minter import this, no parity comment
 * anywhere — this module is the home of config defaults. */
export const DEFAULT_TIMEOUT_MS = 240_000;
/** Chamber lane per-role budget. Measured parity (engine SALVAGE comment: heavy ballots
 * finish 500-700s under shared-GPU load; chamber runs 2026-11-04 died at the 600s default,
 * one over-budget role killing the whole session before the judge — runs
 * sibyl-20261104T094318Z-2421 / ...100648Z-8ed1). Raised 600_000 -> 1_200_000; the kill
 * mechanism itself is untouched (hung roles still die loudly, fail-closed unchanged). */
export const DEFAULT_ROLE_TIMEOUT_MS = 1_200_000;
/** SALVAGE grace after a role deadline (engine SALVAGE precedent, src/engine/index.ts):
 * when the deadline passes we no longer SIGKILL immediately; the process gets this extra
 * budget to finish, so work that provably completes is never discarded. Grace exhausted
 * still SIGKILLs and reports timedOut=true - fail-closed unchanged, quorum unchanged. */
export const DEFAULT_ROLE_SALVAGE_GRACE_MS = 900_000;

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

/** v1.7 credential relay: default per-role request quota at the proxy.
 * L-SINGLE-SOURCE: this is the one definition; schema and any consumer import it. */
export const DEFAULT_PROXY_QUOTA = 2000;

/** http(s) URL without embedded credentials - a key smuggled into the URL
 * would ride every error message and receipt; refused at the parse boundary. */
function isCleanHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.username.length === 0 && u.password.length === 0;
  } catch {
    return false;
  }
}

/**
 * One proxied provider upstream. EXACTLY ONE of keyFile / keyEnv / keyless is
 * required: two is an ambiguous trust decision, zero would silently forward
 * unauthenticated. npm/models steer the synthesized role config (src/lane/
 * isolated.ts synthesizeProxyConfig) so the role needs no other provider data.
 */
export const proxyUpstreamSchema = z
  .object({
    /** real provider endpoint; http(s), no userinfo */
    baseUrl: z.string().refine(isCleanHttpUrl, { error: "baseUrl must be an http(s) URL without embedded credentials" }),
    /** file holding the provider key (read once at relay start, trimmed) */
    keyFile: z.string().min(1).optional(),
    /** env var holding the provider key (read once at relay start, trimmed) */
    keyEnv: z.string().min(1).optional(),
    /** upstream needs no auth (local llama.cpp / vLLM etc.) */
    keyless: z.literal(true).optional(),
    /** opencode npm package that loads this provider (OpenAI-compatible default) */
    npm: z.string().min(1).default("@ai-sdk/openai-compatible"),
    /** model ids exposed under this provider (synthesized into the role config) */
    models: z.array(z.string().min(1)).prefault([]),
  })
  .strict()
  .refine(
    (u) =>
      (u.keyFile !== undefined ? 1 : 0) + (u.keyEnv !== undefined ? 1 : 0) + (u.keyless === true ? 1 : 0) === 1,
    { error: "exactly one of keyFile / keyEnv / keyless is required" },
  );
export type ProxyUpstream = z.infer<typeof proxyUpstreamSchema>;

/**
 * Optional credential proxy (src/lane/proxy.ts). ABSENT (the default) keeps the
 * present lane semantics exactly: roles receive the configSource copy. When
 * set, every seated provider must appear in `providers` (fail-closed at run
 * resolution) and roles receive ONLY a scoped relay token through a synthesized
 * provider-only config - the real key never crosses into a role home or env.
 */
export const credentialProxySchema = z
  .object({
    /** providerID -> real upstream. Only these providers may take a seat. */
    providers: z.record(z.string().min(1), proxyUpstreamSchema).prefault({}),
    /** per-role request quota at the relay; integer >= 1 */
    maxRequestsPerRole: z.number().int().min(1).default(DEFAULT_PROXY_QUOTA),
  })
  .strict();
export type CredentialProxyConfig = z.infer<typeof credentialProxySchema>;

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
  /** H1 anti-bloat (council sibyl-20261114T101952Z-d820): true = keep the
   * engine sessions a done run created; the run then records
   * reclaim:{ran:false, reason:"retainSessions"} and its rows age into the
   * ordinary reap tiers instead. Default false = evidence-first reclaim. */
  retainSessions: z.boolean().default(false),
  /** slot-name -> model pool; "default" entry is mandatory. prefault (not
   * default) so every parse returns a FRESH pool - zod's .default() hands back
   * the same shared object reference and a caller mutation would poison all
   * later parses (proved by a dev-time probe, archived outside this repo). */
  modelPool: modelPoolSchema.prefault(DEFAULT_POOL),
  /** v1.1 isolated-lane mechanics (src/lane/isolated.ts). configSource is
   * READ-COPIED into each role home (never written back). */
  lane: z
    .object({
      runRoot: z.string().min(1).default("/tmp"),
      opencodeBin: z.string().min(1).prefault(discoverOpencodeBin),
      configSource: z.string().prefault(() => join(homedir(), ".config", "opencode", "opencode.jsonc")),
      roleTimeoutMs: z.number().int().min(5_000).default(DEFAULT_ROLE_TIMEOUT_MS),
      roleSalvageGraceMs: z.number().int().min(0).default(DEFAULT_ROLE_SALVAGE_GRACE_MS),
      /** Exam venue: absolute dirs tmpfs-masked from the candidate (grader files,
       * other runs). Empty = venue runs unsandboxed and SAYS SO on the voice face. */
      examMaskDirs: z.array(z.string().min(2)).default([]),
    })
    .prefault({}),
  /** v1.1 E4/F1: seats only from allowed model-id prefixes; deny at launch. */
  modelPolicy: z
    .object({
      allowedPrefixes: z.array(z.string().min(1)).min(1).default(["local-"]),
    })
    .prefault({}),
  /** v1.7 OPTIONAL credential relay (src/lane/proxy.ts). Absent = today's
   * semantics unchanged (roles copy configSource). Present = isolated roles get
   * only a scoped relay token; the relay owns the real keys. */
  credentialProxy: credentialProxySchema.optional(),
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

/**
 * Parse untrusted plugin config into fully-defaulted PluginOptions.
 * Absent config (undefined) means "all defaults". Any other invalid input -
 * including objects whose property getters throw - yields ok:false with
 * readable errors. NEVER throws.
 */
/** Headless discovery of the opencode binary for package defaults:
 * first hit among known install locations, else the bare PATH name
 * "opencode" (spawn resolves it through the child env's PATH). The
 * return is NEVER empty: an empty string violated the min(1) schema and
 * DISABLED the whole plugin on machines without a probed install path
 * (2026-10-03 injury: 30 tests + smoke red here), and an empty bin also
 * crashed spawn with ERR_INVALID_ARG_VALUE. A wrong guess fails LOUD at
 * launchRole spawn time naming the bin, not silently at parse time.
 * Operators override via options.lane.opencodeBin (or OPENCODE_BIN /
 * --opencode-bin on the CLI; see resolveRun's flag->config->env->name order). */
export function discoverOpencodeBin(): string {
  const candidates = [
    process.env["OPENCODE_BIN"] ?? "",
    join(homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) {
    try {
      if (c.length > 0 && existsSync(c)) return c;
    } catch {
      // keep probing
    }
  }
  return "opencode";
}

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
      errors: [`options threw during parsing and was rejected: ${errMessage(err)}`],
    };
  }
}
