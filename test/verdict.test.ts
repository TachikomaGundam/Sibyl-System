// provenance: original clean-room implementation, no external code copied
//
// T3 verdict-layer unit tests. Table-driven: cases are data, one node:test
// row each. Covers tolerant extraction, strict validation, the single
// repair-retry, fail-closed behavior, an adversarial fuzz list (never throws
// + shape invariants), and exact-enum assertions (no truthiness slop).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractVerdictJson,
  validateVerdict,
  parseVerdict,
  rejectVerdict,
  FAIL_CLOSED_REJECT,
  type Verdict,
} from "../src/verdict/index.ts";

// ---------------------------------------------------------------- fixtures

const APPROVE_JSON = '{"verdict":"APPROVE","confidence":0.85,"reasons":["looks good"],"must_fix":[]}';
const REJECT_JSON =
  '{"verdict":"REJECT","confidence":0.9,"reasons":["race condition in flush()"],"must_fix":["guard the write lock"]}';

const APPROVE: Verdict = { verdict: "APPROVE", confidence: 0.85, reasons: ["looks good"], must_fix: [] };
const REJECT: Verdict = {
  verdict: "REJECT",
  confidence: 0.9,
  reasons: ["race condition in flush()"],
  must_fix: ["guard the write lock"],
};

function assertFailClosed(t: Verdict, context: string): void {
  assert.equal(t.verdict, "REJECT", `${context}: fail-closed verdict`);
  assert.equal(t.confidence, 0, `${context}: fail-closed confidence`);
  assert.equal(t.reasons.length, 1, `${context}: exactly one reason`);
  assert.ok(
    t.reasons[0] !== undefined && t.reasons[0].startsWith("verdict-unparseable: "),
    `${context}: reason tagged, got ${JSON.stringify(t.reasons[0])}`,
  );
  assert.deepEqual(t.must_fix, [], `${context}: empty must_fix`);
}

// --------------------------------------------- parseVerdict, no repair

type ParseRow = { name: string; text: string; expect: Verdict | "fail-closed" };

const jsonOf = (o: Record<string, unknown>): string => JSON.stringify(o);

const PARSE_ROWS: ParseRow[] = [
  { name: "valid raw JSON (APPROVE)", text: APPROVE_JSON, expect: APPROVE },
  { name: "valid raw JSON (REJECT)", text: REJECT_JSON, expect: REJECT },
  { name: "fenced ```json block", text: "```json\n" + REJECT_JSON + "\n```", expect: REJECT },
  { name: "fenced bare ``` block", text: "```\n" + APPROVE_JSON + "\n```", expect: APPROVE },
  {
    name: "fenced ```JSON uppercase label",
    text: "```JSON\n" + APPROVE_JSON + "\n```",
    expect: APPROVE,
  },
  {
    name: "JSON with leading and trailing prose",
    text: "Sure! Here is my assessment:\n" + APPROVE_JSON + "\nHope that helps.",
    expect: APPROVE,
  },
  {
    name: "junk braces in prose before the real JSON",
    text: "Note {this} and {also}: " + REJECT_JSON,
    expect: REJECT,
  },
  {
    name: "nested braces inside strings are not truncated",
    text: jsonOf({
      verdict: "REJECT",
      confidence: 0.75,
      reasons: ["macro `X{A{b}B}` expands wrong", "unbalanced { looks in comment"],
      must_fix: ["escape brace { in path {root}/{name}"],
    }),
    expect: {
      verdict: "REJECT",
      confidence: 0.75,
      reasons: ["macro `X{A{b}B}` expands wrong", "unbalanced { looks in comment"],
      must_fix: ["escape brace { in path {root}/{name}"],
    },
  },
  {
    name: "deep nesting (200) inside a string value survives",
    text: jsonOf({
      verdict: "APPROVE",
      confidence: 1,
      reasons: ["{".repeat(200) + "}".repeat(200)],
      must_fix: [],
    }),
    expect: { verdict: "APPROVE", confidence: 1, reasons: ["{".repeat(200) + "}".repeat(200)], must_fix: [] },
  },
  { name: "confidence boundary 0 (APPROVE) accepted", text: '{"verdict":"APPROVE","confidence":0,"reasons":[],"must_fix":[]}', expect: { verdict: "APPROVE", confidence: 0, reasons: [], must_fix: [] } },
  { name: "APPROVE with empty reasons allowed (policy)", text: '{"verdict":"APPROVE","confidence":0.5,"reasons":[],"must_fix":[]}', expect: { verdict: "APPROVE", confidence: 0.5, reasons: [], must_fix: [] } },
  { name: "REJECT with empty reasons rejected (policy)", text: '{"verdict":"REJECT","confidence":0.5,"reasons":[],"must_fix":[]}', expect: "fail-closed" },
  { name: "invalid enum MAYBE", text: '{"verdict":"MAYBE","confidence":0.5,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "verdict lowercase approve rejected", text: '{"verdict":"approve","confidence":0.5,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "confidence 1.5 out of range", text: '{"verdict":"APPROVE","confidence":1.5,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "confidence -0.1 out of range", text: '{"verdict":"APPROVE","confidence":-0.1,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: 'confidence "high" (string)', text: '{"verdict":"APPROVE","confidence":"high","reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: 'confidence "0.5" (stringified number, no coercion)', text: '{"verdict":"APPROVE","confidence":"0.5","reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "confidence null", text: '{"verdict":"APPROVE","confidence":null,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "missing must_fix", text: '{"verdict":"APPROVE","confidence":0.5,"reasons":["x"]}', expect: "fail-closed" },
  { name: "missing reasons", text: '{"verdict":"REJECT","confidence":0.5,"must_fix":["x"]}', expect: "fail-closed" },
  { name: "missing verdict", text: '{"confidence":0.5,"reasons":["x"],"must_fix":[]}', expect: "fail-closed" },
  { name: "reasons not an array (42)", text: '{"verdict":"APPROVE","confidence":0.5,"reasons":42,"must_fix":[]}', expect: "fail-closed" },
  { name: "reasons element not a string", text: '{"verdict":"APPROVE","confidence":0.5,"reasons":["ok",3],"must_fix":[]}', expect: "fail-closed" },
  { name: "must_fix is a bare string", text: '{"verdict":"REJECT","confidence":0.5,"reasons":["x"],"must_fix":"fix it"}', expect: "fail-closed" },
  { name: "unknown extra top-level field rejected", text: '{"verdict":"APPROVE","confidence":0.5,"reasons":[],"must_fix":[],"notes":"extra"}', expect: "fail-closed" },
  { name: "totally non-JSON prose", text: "I looked at it and honestly this LGTM, ship it!", expect: "fail-closed" },
  { name: "empty string", text: "", expect: "fail-closed" },
  { name: "truncated JSON object", text: '{"verdict":"APPROVE","conf', expect: "fail-closed" },
  { name: "unclosed fence falls back to raw scan", text: "```json\n" + APPROVE_JSON, expect: APPROVE },
  {
    name: "fence with valid-but-non-verdict JSON fails validation",
    text: "```json\n" + jsonOf({ config: { retries: 3 }, nested: { deep: true } }) + "\n```",
    expect: "fail-closed",
  },
  { name: "JSON array only (no object)", text: "no verdict here: [1,2,3]", expect: "fail-closed" },
];

for (const row of PARSE_ROWS) {
  test(`parseVerdict (no repair): ${row.name}`, async () => {
    const got = await parseVerdict(row.text);
    if (row.expect === "fail-closed") {
      assertFailClosed(got, row.name);
    } else {
      assert.deepEqual(got, row.expect);
      // exact enum value, not truthiness
      assert.ok(got.verdict === "APPROVE" || got.verdict === "REJECT", "verdict is a literal enum member");
    }
  });
}

// ------------------------------------------------ validateVerdict direct

type ValidateRow = { name: string; raw: unknown; expect: Verdict | { errorPattern: RegExp } };

const VALIDATE_ROWS: ValidateRow[] = [
  { name: "NaN confidence", raw: { verdict: "APPROVE", confidence: Number.NaN, reasons: [], must_fix: [] }, expect: { errorPattern: /confidence/ } },
  { name: "Infinity confidence", raw: { verdict: "APPROVE", confidence: Number.POSITIVE_INFINITY, reasons: [], must_fix: [] }, expect: { errorPattern: /confidence/ } },
  { name: "-Infinity confidence", raw: { verdict: "REJECT", confidence: Number.NEGATIVE_INFINITY, reasons: ["x"], must_fix: [] }, expect: { errorPattern: /confidence/ } },
  { name: "null input", raw: null, expect: { errorPattern: /expected a JSON object/ } },
  { name: "array input", raw: [], expect: { errorPattern: /expected a JSON object/ } },
  { name: "string input", raw: "APPROVE", expect: { errorPattern: /expected a JSON object/ } },
  { name: "number input", raw: 42, expect: { errorPattern: /expected a JSON object/ } },
  { name: "reasons null", raw: { verdict: "APPROVE", confidence: 0.5, reasons: null, must_fix: [] }, expect: { errorPattern: /reasons/ } },
  { name: "confidence boundary 1 ok", raw: { verdict: "APPROVE", confidence: 1, reasons: [], must_fix: [] }, expect: { verdict: "APPROVE", confidence: 1, reasons: [], must_fix: [] } },
  { name: "valid REJECT ok", raw: { verdict: "REJECT", confidence: 0.2, reasons: ["because"], must_fix: ["patch it"] }, expect: { verdict: "REJECT", confidence: 0.2, reasons: ["because"], must_fix: ["patch it"] } },
];

for (const row of VALIDATE_ROWS) {
  test(`validateVerdict: ${row.name}`, () => {
    const res = validateVerdict(row.raw);
    if ("errorPattern" in row.expect) {
      assert.equal(res.ok, false, row.name);
      if (res.ok) return;
      assert.match(res.error, row.expect.errorPattern);
    } else {
      assert.equal(res.ok, true, row.name);
      if (!res.ok) return;
      assert.deepEqual(res.value, row.expect);
    }
  });
}

// ------------------------------------------------ extractVerdictJson

type ExtractRow = { name: string; text: string; expect: string | null };

const EXTRACT_ROWS: ExtractRow[] = [
  { name: "raw object", text: APPROVE_JSON, expect: APPROVE_JSON },
  { name: "fence preferred over later raw object", text: "```json\n" + REJECT_JSON + "\n```\nand also " + APPROVE_JSON, expect: REJECT_JSON },
  { name: "prose with junk braces", text: "{oops then " + APPROVE_JSON, expect: APPROVE_JSON },
  { name: "balanced braces inside string values", text: '{"a":"}"}', expect: '{"a":"}"}' },
  { name: "escaped quote before brace inside string", text: '{"a":"\\"{ \\"}"} tail', expect: '{"a":"\\"{ \\"}"}' },
  { name: "no braces at all", text: "plain prose, no json", expect: null },
  { name: "only unbalanced braces", text: "{{{", expect: null },
  { name: "truncated object", text: '{"a": [1, 2', expect: null },
  { name: "empty string", text: "", expect: null },
];

for (const row of EXTRACT_ROWS) {
  test(`extractVerdictJson: ${row.name}`, () => {
    assert.equal(extractVerdictJson(row.text), row.expect);
  });
}

test("extractVerdictJson: deep nesting (200 levels, valid JSON) returns the full object, not truncated", () => {
  const deep = '{"a":'.repeat(199) + "1" + "}".repeat(199);
  assert.equal(extractVerdictJson(deep), deep);
});

// ------------------------------------------------ repair retry

test("parseVerdict: repair success — repair returns valid JSON, verdict parsed", async () => {
  const bad = '{"verdict":"MAYBE","confidence":0.5,"reasons":["x"],"must_fix":[]}';
  const calls: Array<{ badText: string; why: string }> = [];
  const got = await parseVerdict(bad, async (badText, why) => {
    calls.push({ badText, why });
    return `my fix: ${APPROVE_JSON}`;
  });
  assert.deepEqual(got, APPROVE);
  assert.equal(calls.length, 1, "repair invoked exactly once");
  assert.equal(calls[0]?.badText, bad, "repair receives the original bad text");
  assert.match(calls[0]?.why ?? "", /"MAYBE"/, "repair receives the validation reason");
});

test("parseVerdict: repair fail — still garbage -> FAIL_CLOSED_REJECT shape, reason contains unparseable", async () => {
  const got = await parseVerdict("no json at all", () => "still no json {");
  assertFailClosed(got, "repair-fail");
  const reason = got.reasons[0] ?? "";
  assert.ok(reason.includes("unparseable"), `reason contains 'unparseable': ${reason}`);
  assert.ok(reason.includes("no-json-object-found"), `original why preserved: ${reason}`);
});

test("parseVerdict: repair invoked exactly once even when its output is invalid", async () => {
  let count = 0;
  const got = await parseVerdict(REJECT_JSON.replace("0.9", "42"), (bad) => {
    count++;
    return bad; // echo the same invalid text back
  });
  assert.equal(count, 1, "exactly one repair call");
  assertFailClosed(got, "repair-echo-invalid");
  assert.match(got.reasons[0] ?? "", /repair-invalid/, "second why recorded in fail-closed reason");
});

test("parseVerdict: repair not called for valid input", async () => {
  let count = 0;
  const got = await parseVerdict(APPROVE_JSON, (bad) => {
    count++;
    return bad;
  });
  assert.deepEqual(got, APPROVE);
  assert.equal(count, 0);
});

test("parseVerdict: throwing repair -> fail-closed, never throws", async () => {
  const got = await parseVerdict("garbage {", () => {
    throw new Error("repair exploded");
  });
  assertFailClosed(got, "repair-throws");
  assert.match(got.reasons[0] ?? "", /repair-failed: repair exploded/);
});

test("parseVerdict: rejecting repair -> fail-closed, never rejects", async () => {
  const got = await parseVerdict("garbage {", async () => {
    throw new Error("async repair exploded");
  });
  assertFailClosed(got, "repair-rejects");
  assert.match(got.reasons[0] ?? "", /repair-failed: async repair exploded/);
});

test("parseVerdict: repair returning a non-string -> fail-closed, never throws", async () => {
  const hostile: unknown = {}; // violates the repair's (text) => string contract at runtime
  const got = await parseVerdict("no json at all", () => hostile as string);
  assertFailClosed(got, "repair-non-string");
  assert.match(
    got.reasons[0] ?? "",
    /no-json-object-found \+ repair-failed:/,
    "non-string repair output treated like a throwing repair",
  );
});

// ------------------------------------------------ constants

test("rejectVerdict format is exactly the fail-closed shape", () => {
  assert.deepEqual(rejectVerdict("boom"), {
    verdict: "REJECT",
    confidence: 0,
    reasons: ["verdict-unparseable: boom"],
    must_fix: [],
  });
});

test("FAIL_CLOSED_REJECT is the canonical REJECT/confidence-0 constant", () => {
  assert.equal(FAIL_CLOSED_REJECT.verdict, "REJECT");
  assert.equal(FAIL_CLOSED_REJECT.confidence, 0);
  assert.equal(FAIL_CLOSED_REJECT.reasons.length, 1);
  assert.match(FAIL_CLOSED_REJECT.reasons[0] ?? "", /^verdict-unparseable: /);
  assert.deepEqual(FAIL_CLOSED_REJECT.must_fix, []);
});

// ------------------------------------------------ adversarial fuzz

const HOSTILE_INPUTS: Array<{ name: string; text: string }> = [
  { name: "empty", text: "" },
  { name: "whitespace only", text: "   \t\n  " },
  { name: "lone open brace", text: "{" },
  { name: "lone close brace", text: "}" },
  { name: "empty object", text: "{}" },
  { name: "truncated mid-key", text: '{"verdict":' },
  { name: "control chars", text: "\u0000\u0001\u0002\u001f{}\u007f" },
  { name: "deep nesting 200 balanced", text: "{".repeat(200) + "}".repeat(200) },
  { name: "deep nesting 200 unclosed", text: "{".repeat(200) },
  { name: "unicode + CJK + emoji with valid verdict", text: `🔥 評決 ${APPROVE_JSON} 🔥` },
  { name: "unterminated string", text: '"unterminated { "verdict":"APPROVE"' },
  { name: "backslash escape hell", text: '\\\\\\"{\\\\"verdict\\\\":\\\\"APPROVE\\\\"}' },
  { name: "fence with empty object", text: "```json\n{}\n```" },
  { name: "JSON literals only", text: "null [] true \"string\" NaN undefined" },
  { name: "huge brace soup ~8KB unbalanced", text: "{".repeat(4000) },
  { name: "huge brace soup ~8KB balanced pairs no keys", text: "{}".repeat(2000) },
  { name: "null byte inside otherwise-valid JSON", text: '{"verdict":"APPROVE\u0000","confidence":0.5,"reasons":[],"must_fix":[]}' },
  { name: "verdict key with nested decoy object", text: `{"meta":{"verdict":"APPROVE","confidence":5},"verdict":"MAYBE","confidence":"x","reasons":[],"must_fix":[]}` },
  { name: "multiple candidate objects, last is valid", text: `{"a":1} {"b":{"c":2}} ${REJECT_JSON}` },
  { name: "crlf + tabs around fence", text: "\r\n\t```json\r\n\t" + APPROVE_JSON + "\r\n\t```\r\n" },
];

for (const hostile of HOSTILE_INPUTS) {
  test(`fuzz (never throws, always valid shape): ${hostile.name}`, async () => {
    const t = await parseVerdict(hostile.text);
    assert.ok(t.verdict === "APPROVE" || t.verdict === "REJECT", `verdict enum exact: ${t.verdict}`);
    assert.equal(typeof t.confidence, "number");
    assert.ok(Number.isFinite(t.confidence) && t.confidence >= 0 && t.confidence <= 1, `confidence in [0,1]: ${t.confidence}`);
    assert.ok(Array.isArray(t.reasons) && t.reasons.every((r) => typeof r === "string"));
    assert.ok(Array.isArray(t.must_fix) && t.must_fix.every((m) => typeof m === "string"));
  });
}

test("fuzz: hostile list is at least 10 entries", () => {
  assert.ok(HOSTILE_INPUTS.length >= 10, `${HOSTILE_INPUTS.length} entries`);
});
