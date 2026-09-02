// provenance: original clean-room Sibyl-System implementation (plan task 6 - options
// tests). Defaults, partial-override merge, full bad-config battery, hostile
// input (throwing getters, non-objects), fresh-instance independence, and the
// never-throws contract of parseOptions.

import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCILORS } from "../src/council/index.ts";
import { DEFAULT_TIMEOUT_MS, parseOptions } from "../src/options.ts";
import type { PluginOptions } from "../src/options.ts";

function expectOk(raw: unknown, label: string): PluginOptions {
  const result = parseOptions(raw);
  if (!result.ok) {
    assert.fail(`${label}: expected ok, got errors: ${result.errors.join(" | ")}`);
  }
  return result.options;
}

const VALID_SLOT = { providerID: "anthropic", modelID: "claude-x" };

test("options: empty config applies every documented default", () => {
  const options = expectOk({}, "defaults");
  assert.equal(options.maxRounds, 4);
  assert.equal(options.timeoutMs, 240_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 240_000, "engine DEFAULT_TIMEOUT_MS parity");
  assert.equal(options.concurrencyK, 4);
  assert.equal(options.staggerMs, 2000);
  assert.deepEqual(options.voters, { MELCHIOR: "default", BALTHASAR: "default", CASPER: "default" });
  assert.deepEqual(options.swarm, { judge: "default", pro: "default", con: "default" });
  assert.deepEqual(options.modelPool, { default: { providerID: "", modelID: "" } });
});

test("options: undefined raw means all defaults (no config != broken config)", () => {
  assert.deepEqual(parseOptions(undefined), parseOptions({}));
});

test("options: voters keys are exactly the councilor ids", () => {
  assert.deepEqual(Object.keys(expectOk({}, "voters keys").voters).sort(), [...COUNCILORS].sort());
});

test("options: partial override merges, untouched fields keep defaults", () => {
  const options = expectOk(
    {
      maxRounds: 9,
      voters: { MELCHIOR: "fast" },
      modelPool: { default: VALID_SLOT, fast: { providerID: "openai", modelID: "gpt-mini" } },
    },
    "partial",
  );
  assert.equal(options.maxRounds, 9);
  assert.equal(options.voters.MELCHIOR, "fast");
  assert.equal(options.voters.BALTHASAR, "default");
  assert.equal(options.swarm.judge, "default");
  assert.equal(options.timeoutMs, 240_000);
  assert.deepEqual(options.modelPool.default, VALID_SLOT);
  assert.deepEqual(options.modelPool.fast, { providerID: "openai", modelID: "gpt-mini" });
});

test("options: full valid config round-trips", () => {
  const options = expectOk(
    {
      voters: { MELCHIOR: "a", BALTHASAR: "b", CASPER: "c" },
      swarm: { judge: "j", pro: "p", con: "c" },
      maxRounds: 16,
      timeoutMs: 1,
      concurrencyK: 8,
      staggerMs: 0,
      modelPool: { default: VALID_SLOT },
    },
    "full",
  );
  assert.deepEqual(options.voters, { MELCHIOR: "a", BALTHASAR: "b", CASPER: "c" });
  assert.deepEqual(options.swarm, { judge: "j", pro: "p", con: "c" });
  assert.equal(options.maxRounds, 16);
  assert.equal(options.timeoutMs, 1);
  assert.equal(options.concurrencyK, 8);
  assert.equal(options.staggerMs, 0);
});

// [what is broken, raw config, expected path fragment in the readable errors]
const BAD_CASES: readonly (readonly [string, unknown, string])[] = [
  ["maxRounds is a string", { maxRounds: "4" }, "maxRounds"],
  ["maxRounds below range", { maxRounds: 0 }, "maxRounds"],
  ["maxRounds above range", { maxRounds: 17 }, "maxRounds"],
  ["maxRounds not integer", { maxRounds: 2.5 }, "maxRounds"],
  ["maxRounds null", { maxRounds: null }, "maxRounds"],
  ["maxRounds NaN", { maxRounds: Number.NaN }, "maxRounds"],
  ["timeoutMs zero", { timeoutMs: 0 }, "timeoutMs"],
  ["timeoutMs negative", { timeoutMs: -5 }, "timeoutMs"],
  ["timeoutMs not integer", { timeoutMs: 1.5 }, "timeoutMs"],
  ["concurrencyK below range", { concurrencyK: 0 }, "concurrencyK"],
  ["concurrencyK above range", { concurrencyK: 9 }, "concurrencyK"],
  ["staggerMs negative", { staggerMs: -1 }, "staggerMs"],
  ["voter slot is a number", { voters: { MELCHIOR: 5 } }, "voters.MELCHIOR"],
  ["voter slot empty string", { voters: { CASPER: "" } }, "voters.CASPER"],
  ["judge slot is a boolean", { swarm: { judge: true } }, "swarm.judge"],
  ["pool missing the default entry", { modelPool: { fast: VALID_SLOT } }, "default"],
  ["pool is an empty object", { modelPool: {} }, "default"],
  ["pool entry field has wrong type", { modelPool: { default: { providerID: 5, modelID: "m" } } }, "modelPool.default.providerID"],
  ["pool entry missing modelID", { modelPool: { default: { providerID: "p" } } }, "modelPool.default.modelID"],
  ["pool is not an object", { modelPool: "nope" }, "modelPool"],
  ["voters is not an object", { voters: [] }, "voters"],
];

for (const [label, raw, fragment] of BAD_CASES) {
  test(`options: rejects ${label} with readable error`, () => {
    const result = parseOptions(raw);
    assert.equal(result.ok, false, `${label} must not be accepted`);
    if (result.ok) {
      return;
    }
    assert.ok(result.errors.length > 0, `${label}: errors non-empty`);
    for (const error of result.errors) {
      assert.equal(typeof error, "string");
      assert.ok(error.length > 0, "error message non-empty");
    }
    assert.ok(
      result.errors.some((error) => error.includes(fragment)),
      `errors must mention "${fragment}", got: ${result.errors.join(" | ")}`,
    );
  });
}

test("options: non-object roots are rejected ok:false (never throws)", () => {
  for (const raw of [null, "config string", 42, true, []]) {
    const result = parseOptions(raw);
    assert.equal(result.ok, false, `root ${JSON.stringify(raw)} must be rejected`);
  }
});

test("options: throwing-getter config returns ok:false instead of crashing the host", () => {
  const trap: Record<string, unknown> = { maxRounds: 3 };
  Object.defineProperty(trap, "timeoutMs", {
    enumerable: true,
    get(): never {
      throw new Error("hostile getter");
    },
  });
  const result = parseOptions(trap);
  assert.equal(result.ok, false, "hostile getters must be caught, not propagated");
  if (!result.ok) {
    assert.ok(result.errors.join(" ").includes("hostile getter"), result.errors.join(" | "));
  }
});

test("options: unknown keys are stripped, not errors (forward-compatible config)", () => {
  const options = expectOk({ maxRounds: 5, fromTheFuture: { anything: 1 } }, "unknown keys");
  assert.equal(options.maxRounds, 5);
  assert.ok(!("fromTheFuture" in options));
});

test("options: parsed objects are fresh instances - mutating one config never poisons later parses", () => {
  const first = expectOk({}, "fresh-1");
  first.modelPool.default.providerID = "POISONED";
  first.voters.MELCHIOR = "POISONED";
  const second = expectOk({}, "fresh-2");
  assert.equal(second.modelPool.default.providerID, "");
  assert.equal(second.voters.MELCHIOR, "default");
});
