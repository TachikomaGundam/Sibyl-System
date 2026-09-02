// provenance: original clean-room Sibyl-System implementation (plan task 8 — tools +
// entry), no swarm code copied.
//
// Shared plumbing for the three sibyl_* tools: the execute-context shape, the
// injected dependency bag, the model-slot resolution chain (single source of
// truth for BOTH tools), the artifact input reader (path-or-inline), a
// session-level prompt helper (verdict repair / swarm judge), and the
// error/summary formatters. Pure helpers are IO-light by design: only
// readArtifact touches the filesystem and it NEVER throws — every failure
// path returns a readable string, mirroring the engine's discipline.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { EngineClient, PersonaRunResult } from "../engine/index.ts";
import type { ModelSlot } from "../swarm/types.ts";
import type { RunRecord, RunStore } from "../state/index.ts";
import type { PluginOptions } from "../options.ts";

/**
 * The slice of the SDK ToolContext the tools consume. Structurally compatible
 * with the real context the host passes to execute() (declared here so tools
 * unit-test without importing the SDK). `directory` is PER-SESSION and must
 * always come from this context — never from a closure.
 */
export type ToolContextLike = {
  directory: string;
  abort: AbortSignal;
};

/** Dependencies injected once by the plugin entry (one RunStore instance —
 * its RMW mutex is per-instance; fresh stores per execute risk lost updates). */
export type ToolDeps = {
  client: EngineClient;
  store: RunStore;
  options: PluginOptions;
};

/** Upper bound for accepted artifact content (256 KiB). */
export const ARTIFACT_MAX_BYTES = 262_144;

/** Sentinel slot name that means "no explicit override" (options default). */
export const DEFAULT_SLOT = "default";

/**
 * Resolve the model for one persona (documented chain, single implementation):
 * caller override slot -> persona's own modelSlot -> pool["default"].
 * An override only wins when it is NOT the "default" sentinel AND names an
 * existing pool entry; a missing named slot is NEVER fatal — it silently falls
 * through the chain. The pool's "default" entry is mandatory at config time
 * (src/options.ts), so the chain always terminates in a ModelSlot.
 */
export function slotForModel(
  pool: Record<string, ModelSlot>,
  overrideSlot: string | undefined,
  personaSlot: string | undefined,
): ModelSlot {
  if (overrideSlot !== undefined && overrideSlot !== DEFAULT_SLOT && pool[overrideSlot] !== undefined) {
    return pool[overrideSlot];
  }
  if (personaSlot !== undefined && pool[personaSlot] !== undefined) {
    return pool[personaSlot];
  }
  return pool[DEFAULT_SLOT] as ModelSlot;
}

export type ArtifactInput =
  | { ok: true; kind: "path"; source: string; text: string }
  | { ok: true; kind: "inline"; source: string; text: string }
  | { ok: false; error: string };

/**
 * Interpret a sibyl tool `artifact` argument (marker-free rule): a trimmed
 * value containing a NEWLINE is inline content (no real file path spans two
 * lines); anything else is a file path, resolved relative to `cwd` when not
 * absolute. Files must exist, be regular, and be <= 256 KiB. Never throws —
 * every failure returns {ok:false, error: <readable>}. `source` is the
 * record-facing label (absolute path, or an inline byte-count summary).
 */
export async function readArtifact(raw: string, cwd: string): Promise<ArtifactInput> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "artifact is empty: pass a file path or multi-line inline text" };
  }
  if (trimmed.includes("\n")) {
    return {
      ok: true,
      kind: "inline",
      source: `<inline: ${String(Buffer.byteLength(trimmed, "utf8"))} bytes>`,
      text: trimmed,
    };
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  let info;
  try {
    // stat (follows symlinks): a dangling link is a plain readable error
    // instead of the confusing "not a regular file" an lstat would report.
    info = await stat(path);
  } catch (err) {
    return { ok: false, error: `artifact "${path}": ${errMessage(err)}` };
  }
  if (!info.isFile()) {
    return { ok: false, error: `artifact "${path}": not a regular file` };
  }
  if (info.size > ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      error: `artifact "${path}": ${String(info.size)} bytes exceeds the ${String(ARTIFACT_MAX_BYTES)} byte cap`,
    };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, error: `artifact "${path}": ${errMessage(err)}` };
  }
  return { ok: true, kind: "path", source: path, text };
}

/** Render an unknown error value as a stable string (engine describeError parity:
 * object errors JSON.stringify — "[object Object]" would erase the evidence). */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    return json === undefined ? String(err) : json;
  } catch {
    return String(err);
  }
}

/**
 * The single funnel every tool execute() wraps its body in: a throw must
 * never surface to the host as an opaque crash (spike/GO.md error-handling
 * note — it would lose all structured evidence).
 */
export function internalError(toolName: string, err: unknown): string {
  return `SIBYL ${toolName} internal error: ${errMessage(err)}`;
}

/** Promise.race guard with the timer cleared in finally (engine pattern). */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${String(ms)}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Send one follow-up prompt into an EXISTING session (no create): used by the
 * consult repair path (JSON-only retry in the voter's own session) and the
 * swarm judge. Never throws — timeouts and client-level failures collapse to
 * an ok:false PersonaRunResult with an "exception" stage.
 */
export async function runInSession(
  client: EngineClient,
  directory: string,
  sessionID: string,
  model: ModelSlot,
  text: string,
  timeoutMs: number,
): Promise<PersonaRunResult> {
  const t0 = Date.now();
  const fail = (error: string): PersonaRunResult => ({
    text: "",
    ok: false,
    latencyMs: Date.now() - t0,
    sessionID,
    modelApplied: null,
    stage: "exception",
    error,
  });
  try {
    const prompted = await withTimeout(
      client.session.prompt({
        path: { id: sessionID },
        body: { model, tools: {}, parts: [{ type: "text", text }] },
        query: { directory },
      }),
      timeoutMs,
      "session.prompt",
    );
    if (prompted.error) return fail(errMessage(prompted.error));
    const info = prompted.data?.info;
    if (info?.error) return fail(errMessage(info.error));
    const modelApplied =
      info?.providerID !== undefined && info?.modelID !== undefined
        ? `${info.providerID}/${info.modelID}`
        : null;
    const joined = (prompted.data?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    return { text: joined, ok: true, latencyMs: Date.now() - t0, sessionID, modelApplied };
  } catch (err) {
    return fail(errMessage(err));
  }
}

/** Shared sibyl_status rendering of one run record (oldest-first listings and
 * the single-run detail view both build on this). */
export function formatRunLine(record: RunRecord): string {
  const verdict = record.verdict === undefined ? "-" : `${record.verdict.verdict}(A${String(record.verdict.approvals)}/R${String(record.verdict.rejects)}/E${String(record.verdict.errors)}/M${String(record.verdict.missing)})`;
  const rounds = record.rounds === undefined ? "" : ` rounds=${String(record.rounds)}`;
  const goal = record.goal === undefined ? "" : ` goal="${record.goal}"`;
  return `${record.runId} ${record.kind} ${record.status} ${verdict}${rounds}${goal} created=${record.createdAt} updated=${record.updatedAt} space=${record.spaceDir}`;
}
