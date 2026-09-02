// provenance: original clean-room implementation, no external code copied
//
// Sibyl-System verdict layer (plan task 3, internal design plan).
// Strict JSON verdict contract + tolerant extraction + exactly ONE repair
// retry, fail-closed. Pure functions, zero dependencies (stdlib only),
// no engine / council / state imports.
//
// Contract decisions (documented + enforced by validateVerdict):
// - `reasons` may be empty ONLY for APPROVE. A REJECT without reasons is
//   unactionable and almost always a degenerate model output -> validation
//   rejects it (fail-closed), which routes through repair and ultimately a
//   rejectVerdict() that always carries one reason.
// - `must_fix` must be an array of strings; empty is allowed for both
//   verdicts (approval = no blocking fixes; rejection fixes are a separate
//   channel from reasons).
// - Exactly the four top-level keys, no extras. "Strict JSON contract" means
//   the parser never accepts what the schema does not define; a chatty model
//   adding fields gets one repair attempt, then fail-closed.
// - parseVerdict NEVER throws: JSON.parse and the repair callback are the two
//   throwing seams and both are caught at the boundary. Every failure path
//   returns rejectVerdict(reason) with reason embedded as
//   "verdict-unparseable: <why>".

export type VerdictKind = "APPROVE" | "REJECT";

export type Verdict = {
  verdict: VerdictKind;
  /** Finite number constrained to [0, 1]; enforced by validateVerdict. */
  confidence: number;
  reasons: string[];
  must_fix: string[];
};

export type ValidationResult =
  | { ok: true; value: Verdict }
  | { ok: false; error: string };

export type RepairFn = (badText: string, why: string) => string | Promise<string>;

const OPEN_BRACE = 0x7b; // '{'
const CLOSE_BRACE = 0x7d; // '}'
const QUOTE = 0x22; // '"'
const BACKSLASH = 0x5c; // '\'

const REQUIRED_FIELDS: readonly string[] = ["verdict", "confidence", "reasons", "must_fix"];

/** Fenced code block (```json / ```JSON / bare ```), lazy to the closing fence. */
const FENCE_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isVerdictKind(v: unknown): v is VerdictKind {
  return v === "APPROVE" || v === "REJECT";
}

function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Scan a balanced JSON object starting at `start` (which must point at '{').
 * Braces inside string literals (and after backslash escapes) do not count.
 * Iterative depth counter: survives arbitrarily deep nesting without
 * recursion. Returns the raw substring incl. both braces, or null if the
 * object never closes (truncated input).
 */
function findBalancedObject(text: string, start: number): string | null {
  if (text.charCodeAt(start) !== OPEN_BRACE) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === BACKSLASH) escaped = true;
      else if (c === QUOTE) inString = false;
      continue;
    }
    if (c === QUOTE) inString = true;
    else if (c === OPEN_BRACE) depth++;
    else if (c === CLOSE_BRACE) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * First balanced-brace candidate in `text` that is valid JSON. Candidates
 * that scan balanced but fail to parse (prose like `{this}`) are skipped, so
 * junk braces before the real payload do not hide it.
 */
function firstParseableObject(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== OPEN_BRACE) continue;
    const candidate = findBalancedObject(text, i);
    if (candidate === null) continue; // unterminated '{' — try the next one
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // balanced but not valid JSON — try the next candidate
    }
  }
  return null;
}

/**
 * Tolerant extraction of a JSON object from a (possibly chatty) model output.
 * Prefers fenced code blocks (```json / bare ```); falls back to a raw
 * balanced-brace scan of the whole text. Returns the raw JSON substring or
 * null when no parseable object exists. Extraction only: semantic validity
 * is validateVerdict's job, so this may return a JSON object that is not a
 * valid verdict.
 */
export function extractVerdictJson(text: string): string | null {
  for (const m of text.matchAll(FENCE_RE)) {
    const fenced = firstParseableObject(m[1] ?? "");
    if (fenced !== null) return fenced;
  }
  return firstParseableObject(text);
}

function checkStringArray(
  value: unknown,
  field: string,
): { ok: true; items: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} must be an array of strings, got ${describeValue(value)}` };
  }
  const items: string[] = [];
  for (const [i, el] of value.entries()) {
    if (typeof el !== "string") {
      return { ok: false, error: `${field}[${i}] must be a string, got ${describeValue(el)}` };
    }
    items.push(el);
  }
  return { ok: true, items };
}

/** Exact-field validation of an already-parsed JSON value against the Verdict schema. */
export function validateVerdict(raw: unknown): ValidationResult {
  if (!isRecord(raw)) {
    return { ok: false, error: `expected a JSON object, got ${describeValue(raw)}` };
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in raw));
  if (missing.length > 0) {
    return { ok: false, error: `missing required field(s): ${missing.join(", ")}` };
  }
  const extra = Object.keys(raw).filter((k) => !REQUIRED_FIELDS.includes(k));
  if (extra.length > 0) {
    return { ok: false, error: `unknown field(s): ${extra.join(", ")}` };
  }

  const kind = raw["verdict"];
  if (!isVerdictKind(kind)) {
    return { ok: false, error: `verdict must be "APPROVE" or "REJECT", got ${describeValue(kind)}` };
  }

  const confidence = raw["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: `confidence must be a finite number in [0, 1], got ${describeValue(confidence)}` };
  }

  const reasons = checkStringArray(raw["reasons"], "reasons");
  if (!reasons.ok) return reasons;
  if (kind === "REJECT" && reasons.items.length === 0) {
    return { ok: false, error: `REJECT verdict requires at least one reason, got empty "reasons"` };
  }

  const mustFix = checkStringArray(raw["must_fix"], "must_fix");
  if (!mustFix.ok) return mustFix;

  return {
    ok: true,
    value: { verdict: kind, confidence, reasons: reasons.items, must_fix: mustFix.items },
  };
}

/** The fail-closed verdict: REJECT, zero confidence, one "verdict-unparseable" reason. */
export function rejectVerdict(reason: string): Verdict {
  return {
    verdict: "REJECT",
    confidence: 0,
    reasons: [`verdict-unparseable: ${reason}`],
    must_fix: [],
  };
}

/** Canonical fail-closed constant (the value used when no attempt even ran). */
export const FAIL_CLOSED_REJECT: Verdict = rejectVerdict("no-parse-performed");

type Attempt = { ok: true; value: Verdict } | { ok: false; why: string };

function attemptParse(text: string): Attempt {
  const json = extractVerdictJson(text);
  if (json === null) return { ok: false, why: "no-json-object-found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, why: `invalid-json: ${e instanceof Error ? e.message : describeValue(e)}` };
  }
  const result = validateVerdict(parsed);
  return result.ok ? result : { ok: false, why: result.error };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : describeValue(e);
}

/**
 * extract -> validate; on failure call `repair` EXACTLY ONCE (if provided)
 * with the original bad text and the reason, then re-extract/validate its
 * output. Still failing (or no repair given, or repair itself throws) ->
 * fail-closed rejectVerdict(). Never throws.
 */
export async function parseVerdict(text: string, repair?: RepairFn): Promise<Verdict> {
  const first = attemptParse(text);
  if (first.ok) return first.value;
  if (repair === undefined) return rejectVerdict(first.why);

  let repairedText: string;
  try {
    repairedText = await repair(text, first.why);
  } catch (e) {
    return rejectVerdict(`${first.why} + repair-failed: ${errorMessage(e)}`);
  }

  let second: Attempt;
  try {
    second = attemptParse(repairedText);
  } catch (e) {
    return rejectVerdict(`${first.why} + repair-failed: ${errorMessage(e)}`);
  }
  if (second.ok) return second.value;
  return rejectVerdict(`${first.why} + repair-invalid: ${second.why}`);
}
