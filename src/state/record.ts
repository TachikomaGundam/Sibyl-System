// provenance: original clean-room Sibyl-System implementation (T5 state layer),
// no external code copied. Run record schema + element-level validation.
// Swarm-era crash lesson applied: a single malformed entry must never be
// fatal — validateEntry reports a reason, the store drops that one element.

/** Env seam overriding the runs file (tests / CI isolation). */
export const SIBYL_STATE_FILE_ENV = "SIBYL_STATE_FILE";

export const RUN_KINDS = ["consult", "swarm"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ["running", "done", "failed", "suspended"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// CANNOT_ANSWER (added 2026-09-29 after the G10 review series): the council could
// not form a decision — error/missing ballots left neither an approval path nor a
// decided rejection. It is NOT a substantive reject: conflating a wounded ruler
// with an adverse vote lets infra failures veto on the merits (run
// sibyl-20260928T182401Z-a061: 2A/0R/1E was reported as REJECT). Fail-closed is
// preserved: CANNOT_ANSWER can never APPROVE; the user-pinned rule
// (any error/missing vote makes APPROVE impossible) still holds verbatim.
export const VERDICT_TAGS = ["APPROVE", "REJECT", "CANNOT_ANSWER"] as const;
export type VerdictTag = (typeof VERDICT_TAGS)[number];

export type RunVerdict = {
  verdict: VerdictTag;
  approvals: number;
  rejects: number;
  errors: number;
  missing: number;
};

/** W3 instrument-version-on-the-ballot: which ruler face spoke this ballot.
 * rulesHash folds the whole component set; components maps each hashed text
 * (persona prompt / criteria) to its sha256 so a re-evaluation can name the
 * exact ruler each side ran under. */
export const INSTRUMENT_NAME = /^[a-z0-9-]{1,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type InstrumentRef = {
  rulesHash: string;
  components: Record<string, string>;
};

export function isInstrumentShape(v: unknown): v is InstrumentRef {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["rulesHash"] !== "string" || !HEX64.test(o["rulesHash"])) return false;
  const comps = o["components"];
  if (typeof comps !== "object" || comps === null || Array.isArray(comps)) return false;
  return Object.entries(comps as Record<string, unknown>).every(
    ([name, hash]) => INSTRUMENT_NAME.test(name) && typeof hash === "string" && HEX64.test(hash),
  );
}

/** Fresh rebuild (audit F2 pattern): no aliasing of parsed JSON, no foreign
 * own keys (incl. a data-property "__proto__") surviving into the record. */
export function rebuildInstrument(v: InstrumentRef): InstrumentRef {
  return {
    rulesHash: v.rulesHash,
    components: Object.fromEntries(Object.entries(v.components).map(([name, hash]) => [name, hash])),
  };
}

/**
 * Durable record of one SIBYL run. JSON-serializable; ISO-8601 strings for
 * dates. Documented extensions over the base plan shape: `notes` (freeform
 * operator trail); a missing/invalid `updatedAt` is repaired to `createdAt`
 * on load instead of dropping the entry.
 */
export type RunRecord = {
  runId: string;
  kind: RunKind;
  artifact: string;
  goal?: string;
  status: RunStatus;
  verdict?: RunVerdict;
  rounds?: number;
  spaceDir: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  instrument?: InstrumentRef;
};

/** Rename implementation seam (tests inject a flaky rename to exercise the
 * Windows EPERM/EBUSY fallback in save(); production always uses fs.rename). */
export type RenameFile = (from: string, to: string) => Promise<void>;

export type RunStoreOptions = {
  /** Explicit runs file; beats SIBYL_STATE_FILE env, beats the default. */
  runsFile?: string;
  /** Explicit space root; beats the `~/.sibyl/spaces` default (tests inject tmp dirs). */
  spaceRoot?: string;
  /** Test seam overriding the atomic-rename step; default `fs/promises.rename`. */
  rename?: RenameFile;
};

/** Per-call save() overrides (same rename seam, call scope wins). */
export type SaveOptions = {
  rename?: RenameFile;
};

export type CreateRunInput = {
  kind: RunKind;
  artifact: string;
  goal?: string;
  /** Per-call space root override (falls back to the store's spaceRoot). */
  spaceRootDir?: string;
};

export type EntryVerdict = { ok: true; record: RunRecord } | { ok: false; reason: string };

function oneOf<T extends readonly [string, ...string[]]>(v: unknown, opts: T): v is T[number] {
  return opts.some((o) => o === v);
}

function field(obj: object, key: string): unknown {
  return Reflect.get(obj, key);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Primitive ISO check: any Date-parsable non-empty string. */
function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

const VERDICT_COUNTS = ["approvals", "rejects", "errors", "missing"] as const;

function isVerdictLike(v: unknown): v is RunVerdict {
  if (typeof v !== "object" || v === null) return false;
  if (!oneOf(field(v, "verdict"), VERDICT_TAGS)) return false;
  return VERDICT_COUNTS.every((k) => {
    const n = field(v, k);
    return typeof n === "number" && Number.isInteger(n) && n >= 0;
  });
}

/** Element-level validity: runId/kind/artifact/status/spaceDir/createdAt
 * must pass primitive checks; optional fields, when present, must be
 * well-typed. Repairs a missing/invalid updatedAt to createdAt. */
export function validateEntry(raw: unknown): EntryVerdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "entry is not an object" };
  }
  const runId = field(raw, "runId");
  if (!isNonEmptyString(runId)) return { ok: false, reason: "runId must be a non-empty string" };
  const kind = field(raw, "kind");
  if (!oneOf(kind, RUN_KINDS)) return { ok: false, reason: `kind must be one of ${RUN_KINDS.join("|")}` };
  const artifact = field(raw, "artifact");
  if (!isNonEmptyString(artifact)) return { ok: false, reason: "artifact must be a non-empty string" };
  const status = field(raw, "status");
  if (!oneOf(status, RUN_STATUSES)) return { ok: false, reason: `status must be one of ${RUN_STATUSES.join("|")}` };
  const spaceDir = field(raw, "spaceDir");
  if (!isNonEmptyString(spaceDir)) return { ok: false, reason: "spaceDir must be a non-empty string" };
  const createdAt = field(raw, "createdAt");
  if (!isIsoDate(createdAt)) return { ok: false, reason: "createdAt must be an ISO date string" };

  const rawUpdatedAt = field(raw, "updatedAt");
  const record: RunRecord = {
    runId,
    kind,
    artifact,
    status,
    spaceDir,
    createdAt,
    updatedAt: isIsoDate(rawUpdatedAt) ? rawUpdatedAt : createdAt,
  };
  const goal = field(raw, "goal");
  if (goal !== undefined) {
    if (typeof goal !== "string") return { ok: false, reason: "goal must be a string when present" };
    record.goal = goal;
  }
  const verdict = field(raw, "verdict");
  if (verdict !== undefined) {
    if (!isVerdictLike(verdict)) return { ok: false, reason: "verdict must be a RunVerdict when present" };
    // Audit F2: rebuild a fresh exact-5-field object instead of aliasing the
    // parsed JSON — extra own keys (incl. a data-property "__proto__") must
    // not survive into the in-memory record or get laundered back by save().
    record.verdict = {
      verdict: verdict.verdict,
      approvals: verdict.approvals,
      rejects: verdict.rejects,
      errors: verdict.errors,
      missing: verdict.missing,
    };
  }
  const rounds = field(raw, "rounds");
  if (rounds !== undefined) {
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) {
      return { ok: false, reason: "rounds must be a non-negative integer when present" };
    }
    record.rounds = rounds;
  }
  const notes = field(raw, "notes");
  if (notes !== undefined) {
    if (typeof notes !== "string") return { ok: false, reason: "notes must be a string when present" };
    record.notes = notes;
  }
  const instrument = field(raw, "instrument");
  if (instrument !== undefined) {
    if (!isInstrumentShape(instrument)) {
      return { ok: false, reason: "instrument must be {rulesHash: 64-hex, components: name->64-hex} when present" };
    }
    record.instrument = rebuildInstrument(instrument);
  }
  return { ok: true, record };
}

/** createdAt ascending; Array.sort stability keeps ties in insertion order. */
export function byCreatedAt(a: RunRecord, b: RunRecord): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Compact ISO stamp: 20260902T123456Z (no colons/dots — filename safe). */
export function compactIso(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
