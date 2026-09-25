// provenance: original clean-room Sibyl-System implementation (v1.1 chamber
// records), no external code copied. L6/L7 + A4/A5 + E2 record discipline.
//
// Three durable surfaces, each with its own law:
//  1. run-record.json inside the run dir  — the run FACE. Regenerated as the
//     TERMINAL write of every stage (L7 face-last): tmp+rename like the T5
//     store, artifacts RE-HASHED from disk at regen (assertOnDisk discipline —
//     a claimed hash that contradicts the bytes is refused, never laundered).
//  2. chamber-ledger.jsonl (state root)   — append-only, EOF-only, exactly one
//     JSON document per LINE. JSON.parse's trailing-garbage error is the
//     merged-row guard: a `{..}{..}` line fails to parse and is reported in
//     `dropped`, never silently accepted (A5). Serials are assigned at append
//     time from the current line count; a START row carries the E2 drawCommit.
//  3. CHECKSUMS.txt inside the run dir    — machine-generated `sha256  relpath`
//     lines (self excluded; the run-record is excluded too because face-last
//     rewrites it after checksumming). spotcheckCommand() prints the one
//     verification command a human pastes (A4).

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isNonEmptyString } from "./record.ts";

/** v1.1 append-only chamber ledger; sibling of ~/.sibyl/runs.json (T5 root). */
export const DEFAULT_CHAMBER_LEDGER: string = join(homedir(), ".sibyl", "chamber-ledger.jsonl");

/** L6 explicit terminal states — a run ends in exactly one of these. */
export const TERMINAL_STATES = ["CONVERGED", "NEEDS_ROUND", "MEMBER_LOST", "TIMEOUT"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** O2 centralism: the single external conclusion vocabulary. */
export const CONCLUSIONS = ["APPROVE", "REJECT", "NEEDS_HUMAN"] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

export const RUN_PROFILES = ["review", "exam"] as const;
export type RunProfile = (typeof RUN_PROFILES)[number];

export const RECORD_SCHEMA = 1;

/** One launched role-phase with its on-disk receipt (L5: artifact = status). */
export type ArtifactRef = {
  role: string;
  round: number;
  phase: string;
  /** Path relative to the run dir (portable across spotchecks). */
  relPath: string;
  sha256: string;
  bytes: number;
  /** ISO time the file was last observed present+non-empty (receipt, not reply). */
  presentAt: string;
  /** Process exit facts (L4/L6 attribution). */
  rc: number | null;
  signal: string | null;
  timedOut: boolean;
};

/** One roster seat as resolved BEFORE launch (E4 decision is part of the record). */
export type RosterRef = {
  role: string;
  slot: string;
  modelId: string;
  policyCheck: "allow" | "deny";
  denyReason?: string;
};

export type ChamberRecord = {
  schema: number;
  runId: string;
  /** Ledger serial assigned at START append (C-06). */
  serial: number;
  profile: RunProfile;
  goal: string;
  target: string;
  runDir: string;
  createdAt: string;
  updatedAt: string;
  terminal: TerminalState | null;
  roster: RosterRef[];
  /** E2: pool ids + seed + commit, all recorded before any candidate launch. */
  judgePool: string[];
  seed: string;
  drawCommit: string;
  judgeModelId: string;
  rounds: number;
  artifacts: ArtifactRef[];
  evidenceRows: number;
  notes?: string;
};

/* ── hashing primitives (machine-generated, never prose) ─────────────── */

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 + byte size of a file; never throws — absence is a structured miss. */
export async function sha256File(
  path: string,
): Promise<{ ok: true; sha256: string; bytes: number } | { ok: false; reason: string }> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const code = typeof err === "object" && err !== null ? String(Reflect.get(err, "code")) : "unknown";
    return { ok: false, reason: `read failed (${code})` };
  }
  return { ok: true, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.byteLength };
}

/**
 * L7 claim discipline: a hash/size claim survives ONLY if re-reading disk in
 * the same script run proves it. Drift is reported, never repaired silently.
 */
export async function assertOnDisk(
  path: string,
  claim: { sha256: string; bytes: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = await sha256File(path);
  if (!now.ok) return { ok: false, reason: `${path}: ${now.reason}` };
  if (now.sha256 !== claim.sha256) return { ok: false, reason: `${path}: hash drift (claimed ${claim.sha256.slice(0, 12)}…, disk ${now.sha256.slice(0, 12)}…)` };
  if (now.bytes !== claim.bytes) return { ok: false, reason: `${path}: size drift (claimed ${String(claim.bytes)}, disk ${String(now.bytes)})` };
  return { ok: true };
}

/* ── record validity ─────────────────────────────────────────────────── */

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? [...v] : null;
}

function isRosterRef(v: unknown): v is RosterRef {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isNonEmptyString(o["role"]) &&
    isNonEmptyString(o["slot"]) &&
    isNonEmptyString(o["modelId"]) &&
    (o["policyCheck"] === "allow" || o["policyCheck"] === "deny") &&
    (o["denyReason"] === undefined || typeof o["denyReason"] === "string")
  );
}

function isArtifactRef(v: unknown): v is ArtifactRef {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isNonEmptyString(o["role"]) &&
    typeof o["round"] === "number" &&
    Number.isInteger(o["round"]) &&
    o["round"] >= 0 &&
    isNonEmptyString(o["phase"]) &&
    isNonEmptyString(o["relPath"]) &&
    typeof o["sha256"] === "string" &&
    /^[0-9a-f]{64}$/.test(o["sha256"] as string) &&
    typeof o["bytes"] === "number" &&
    o["bytes"] >= 0 &&
    isNonEmptyString(o["presentAt"]) &&
    (o["rc"] === null || typeof o["rc"] === "number") &&
    (o["signal"] === null || typeof o["signal"] === "string") &&
    typeof o["timedOut"] === "boolean"
  );
}

/** Element-level validation for ledger/face rows; reports a reason, never throws. */
export function validateChamberRecord(raw: unknown): { ok: true; record: ChamberRecord } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "record is not an object" };
  const o = raw as Record<string, unknown>;
  if (o["schema"] !== RECORD_SCHEMA) return { ok: false, reason: `schema must be ${RECORD_SCHEMA}` };
  if (!isNonEmptyString(o["runId"])) return { ok: false, reason: "runId must be a non-empty string" };
  if (typeof o["serial"] !== "number" || !Number.isInteger(o["serial"]) || o["serial"] < 1) return { ok: false, reason: "serial must be a positive integer" };
  if (!(RUN_PROFILES as readonly unknown[]).includes(o["profile"])) return { ok: false, reason: `profile must be one of ${RUN_PROFILES.join("|")}` };
  if (!isNonEmptyString(o["goal"])) return { ok: false, reason: "goal must be a non-empty string" };
  if (typeof o["target"] !== "string") return { ok: false, reason: "target must be a string" };
  if (!isNonEmptyString(o["runDir"]) || !isAbsolute(o["runDir"])) return { ok: false, reason: "runDir must be an absolute path" };
  if (!isNonEmptyString(o["createdAt"]) || Number.isNaN(Date.parse(o["createdAt"]))) return { ok: false, reason: "createdAt must be ISO" };
  if (!isNonEmptyString(o["updatedAt"]) || Number.isNaN(Date.parse(o["updatedAt"]))) return { ok: false, reason: "updatedAt must be ISO" };
  if (o["terminal"] !== null && !(TERMINAL_STATES as readonly unknown[]).includes(o["terminal"])) return { ok: false, reason: "terminal must be null or a TerminalState" };
  if (!Array.isArray(o["roster"]) || !o["roster"].every(isRosterRef)) return { ok: false, reason: "roster must be an array of RosterRef" };
  const judgePool = asStringArray(o["judgePool"]);
  if (judgePool === null) return { ok: false, reason: "judgePool must be a string array" };
  if (!isNonEmptyString(o["seed"])) return { ok: false, reason: "seed must be a non-empty string" };
  if (typeof o["drawCommit"] !== "string" || !/^[0-9a-f]{64}$/.test(o["drawCommit"])) return { ok: false, reason: "drawCommit must be 64-hex" };
  if (typeof o["judgeModelId"] !== "string") return { ok: false, reason: "judgeModelId must be a string" };
  if (typeof o["rounds"] !== "number" || !Number.isInteger(o["rounds"]) || o["rounds"] < 0) return { ok: false, reason: "rounds must be a non-negative integer" };
  if (!Array.isArray(o["artifacts"]) || !o["artifacts"].every(isArtifactRef)) return { ok: false, reason: "artifacts must be an array of ArtifactRef" };
  if (typeof o["evidenceRows"] !== "number" || !Number.isInteger(o["evidenceRows"]) || o["evidenceRows"] < 0) return { ok: false, reason: "evidenceRows must be a non-negative integer" };
  if (o["notes"] !== undefined && typeof o["notes"] !== "string") return { ok: false, reason: "notes must be a string when present" };
  const record: ChamberRecord = {
    schema: RECORD_SCHEMA,
    runId: o["runId"],
    serial: o["serial"],
    profile: o["profile"] as RunProfile,
    goal: o["goal"],
    target: o["target"],
    runDir: o["runDir"],
    createdAt: o["createdAt"],
    updatedAt: o["updatedAt"],
    terminal: o["terminal"] as TerminalState | null,
    roster: [...(o["roster"] as RosterRef[])],
    judgePool,
    seed: o["seed"],
    drawCommit: o["drawCommit"],
    judgeModelId: o["judgeModelId"],
    rounds: o["rounds"],
    artifacts: [...(o["artifacts"] as ArtifactRef[])],
    evidenceRows: o["evidenceRows"],
  };
  if (typeof o["notes"] === "string") record.notes = o["notes"];
  return { ok: true, record };
}

/* ── serial ledger (EOF-append, one JSON per line — A5) ──────────────── */

export type LedgerAppendResult = { ok: true; serial: number; line: string } | { ok: false; reason: string };

/**
 * Assign the next serial and append exactly one line at EOF. A row that would
 * serialize with an embedded newline (unstringified user text) is refused —
 * the ledger's one-doc-per-line invariant is what makes merged rows detectable.
 */
export async function appendLedgerRow(ledgerPath: string, record: ChamberRecord): Promise<LedgerAppendResult> {
  let existing = "";
  try {
    existing = await readFile(ledgerPath, "utf8");
  } catch (err) {
    const code = typeof err === "object" && err !== null ? String(Reflect.get(err, "code")) : "unknown";
    if (code !== "ENOENT") return { ok: false, reason: `ledger read failed (${code})` };
  }
  // Serial = count of PARSEABLE lines + 1; corrupt lines still consume a serial
  // slot (counted physically) so a tampered line can never shift later serials
  // back onto an earlier identity.
  const physicalLines = existing.length === 0 ? 0 : existing.split("\n").filter((l) => l.trim().length > 0).length;
  const serial = physicalLines + 1;
  const stamped: ChamberRecord = { ...record, serial };
  const line = JSON.stringify(stamped);
  if (line.includes("\n")) return { ok: false, reason: "row serializes with a newline — refused (ledger is one-JSON-per-line)" };
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${line}\n`, { flag: "a" }); // O_APPEND: EOF-only (L7)
  return { ok: true, serial, line };
}

export type LedgerLineVerdict = { ok: true; record: ChamberRecord } | { ok: false; reason: string };

/** Parse ONE ledger line. A merged `{..}{..}` row fails here by design (A5):
 * JSON.parse rejects trailing content, and we ALSO verify the re-serialized
 * document round-trips so structurally odd payloads cannot slip through. */
export function parseLedgerLine(line: string): LedgerLineVerdict {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: "blank line" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `not a single JSON document (merged-row guard): ${msg}` };
  }
  const v = validateChamberRecord(parsed);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, record: v.record };
}

export type LedgerLoad = { rows: ChamberRecord[]; dropped: { line: number; reason: string }[] };

/** Load the ledger without ever being fatal (T5 lesson): every bad line is
 * REPORTED in `dropped` — acceptance requires dropped.length === 0 on clean
 * stores; presence of drops is loud, countable evidence, not a crash. */
export async function loadLedger(ledgerPath: string): Promise<LedgerLoad> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    return { rows: [], dropped: [] };
  }
  const rows: ChamberRecord[] = [];
  const dropped: { line: number; reason: string }[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const v = parseLedgerLine(line);
    if (v.ok) rows.push(v.record);
    else dropped.push({ line: i + 1, reason: v.reason });
  }
  return { rows, dropped };
}

/* ── face record + checksums + spotcheck (A4, L7 face-last) ──────────── */

export const RECORD_FILE = "run-record.json";
export const CHECKSUMS_FILE = "CHECKSUMS.txt";
export const LEDGER_LINE_FILE = "ledger-line.txt";

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Re-hash every artifact claim against disk (L7: claims are only written when
 * the same script proves them from bytes), stamp updatedAt, and regenerate the
 * face record as the TERMINAL write. Returns the drift list — non-empty drift
 * refuses the face write (loud, per assertOnDisk discipline).
 */
export type FinalizeResult =
  | { ok: true; record: ChamberRecord; ledgerSerial?: number }
  | { ok: false; drift: string[] };

export async function finalizeRecord(
  record: ChamberRecord,
  opts?: { writeLedger?: { path: string }; checksums?: boolean },
): Promise<FinalizeResult> {
  const drift: string[] = [];
  for (const art of record.artifacts) {
    const abs = resolve(record.runDir, art.relPath);
    const check = await assertOnDisk(abs, { sha256: art.sha256, bytes: art.bytes });
    if (!check.ok) drift.push(check.reason);
  }
  if (drift.length > 0) return { ok: false, drift };

  let fresh: ChamberRecord = { ...record, updatedAt: new Date().toISOString() };
  let ledgerSerial: number | undefined;
  if (opts?.writeLedger !== undefined) {
    const appended = await appendLedgerRow(opts.writeLedger.path, fresh);
    if (!appended.ok) return { ok: false, drift: [`ledger append refused: ${appended.reason}`] };
    ledgerSerial = appended.serial;
    // face and ledger row must agree on the serial — stamp before the face write
    fresh = { ...fresh, serial: appended.serial };
    // Pin the exact appended row inside the run dir so the spotcheck (which
    // runs from the run dir) covers THIS run's ledger line even when the
    // shared ledger lives elsewhere. Written BEFORE checksums, face LAST.
    await atomicWrite(join(record.runDir, LEDGER_LINE_FILE), `${appended.line}\n`);
  }
  if (opts?.checksums) {
    const files = await listChecksumTargets(record.runDir);
    await writeChecksums(record.runDir, files);
  }
  // Face-last ordering: run-record.json is the LAST write of this stage.
  await atomicWrite(join(record.runDir, RECORD_FILE), `${JSON.stringify(fresh, null, 2)}\n`);
  return ledgerSerial === undefined
    ? { ok: true, record: fresh }
    : { ok: true, record: fresh, ledgerSerial };
}

/** Directories/files that are the role RUNTIME (sandbox homes, live dbs,
 * logs) — they keep mutating after terminal close and are NOT part of the
 * review record; the sealed review surface is what spotcheck verifies. */
const RUNTIME_DIRS = new Set(["home", "workspace", "pids"]);
const RUNTIME_EXT = [".db", ".db-wal", ".db-shm", ".log", ".tmp"];

function isRuntimeSurface(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((seg) => RUNTIME_DIRS.has(seg))) return true;
  return RUNTIME_EXT.some((ext) => rel.endsWith(ext));
}

/** The review-record surface (artifacts, prompts, target, disagreement log,
 * ledger mirror) — excludes self-referential files and the role runtime. */
export async function listChecksumTargets(runDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (RUNTIME_DIRS.has(e.name) && resolve(dir) !== resolve(runDir)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        const rel = resolve(abs).slice(resolve(runDir).length + 1);
        if (rel === CHECKSUMS_FILE || rel === RECORD_FILE) continue;
        if (isRuntimeSurface(rel)) continue;
        out.push(rel);
      }
    }
  }
  await walk(runDir);
  out.sort();
  return out;
}

/** CHECKSUMS.txt: `<sha256>  <relpath>` lines (sha256sum -c compatible). */
export async function writeChecksums(runDir: string, files: readonly string[]): Promise<void> {
  const lines: string[] = [];
  for (const rel of files) {
    const h = await sha256File(resolve(runDir, rel));
    if (!h.ok) return; // a vanished file simply isn't checksummed this face
    lines.push(`${h.sha256}  ${rel}`);
  }
  await atomicWrite(join(runDir, CHECKSUMS_FILE), `${lines.join("\n")}\n`);
}

/** A4: the one command a human pastes to verify every recorded byte. */
export function spotcheckCommand(runDir: string): string {
  return `cd ${runDir} && sha256sum -c ${CHECKSUMS_FILE}`;
}
