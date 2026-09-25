// provenance: v1.1 lane tests — E4/F1 seating prefilter + E2 draw-commit.
// Locks: policy DENY happens at resolve time (no spawn could "get lucky"),
// cloud placeholders denied, deterministic judge draw, and the drawCommit
// changing if pool or seed changes later.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDrawCommit,
  drawJudge,
  policyAllows,
  resolveSeat,
  toModelId,
  type SeatPool,
  type SeatPolicy,
} from "../src/lane/seating.ts";

const pool: SeatPool = {
  default: { providerID: "local-qwen", modelID: "qwen3.8-flash-next" },
  fast: { providerID: "local-qwen", modelID: "small" },
  cloud: { providerID: "openai", modelID: "gpt-astronomy" },
  blank: { providerID: "", modelID: "" },
};
const localPolicy: SeatPolicy = { allowedPrefixes: ["local-"] };

test("resolveSeat: local slot passes with the resolved modelId", () => {
  const d = resolveSeat("pro", "fast", pool, localPolicy);
  assert.ok(d.ok);
  assert.equal(d.modelId, "local-qwen/small");
  assert.equal(d.role, "pro");
});

test("resolveSeat: cloud seat is DENIED at resolve, never deferred to provider luck (F1)", () => {
  const d = resolveSeat("judge", "cloud", pool, localPolicy);
  assert.ok(!d.ok);
  assert.match(d.deny, /modelPolicy/);
  assert.match(d.deny, /openai\/gpt-astronomy/);
  assert.match(d.deny, /must not be attempted/);
});

test("resolveSeat: empty placeholder is denied; unknown slot falls to default; missing default denies", () => {
  assert.ok(!resolveSeat("con", "blank", pool, localPolicy).ok);
  const fell = resolveSeat("con", "nope", pool, localPolicy);
  assert.ok(fell.ok);
  if (!fell.ok) return;
  assert.equal(fell.modelId, "local-qwen/qwen3.8-flash-next");
  const { blank: _b, cloud: _c, default: _d, ...noDefault } = pool;
  assert.ok(!resolveSeat("con", "ghost", noDefault, localPolicy).ok, "no slot + no default -> deny");
});

test("policyAllows: prefix semantics (empty prefixes deny everything)", () => {
  assert.ok(policyAllows("local-qwen/x", localPolicy));
  assert.ok(!policyAllows("openai/x", localPolicy));
  assert.ok(!policyAllows("local-x", { allowedPrefixes: [] }));
});

test("drawCommit: E2 commit binds pool order AND seed (any change flips it)", () => {
  const ids = ["local-qwen/a", "local-qwen/b"];
  const base = computeDrawCommit(ids, "seed-1");
  assert.equal(computeDrawCommit(ids, "seed-1"), base, "same inputs replay");
  assert.notEqual(computeDrawCommit([...ids].reverse(), "seed-1"), base, "order matters");
  assert.notEqual(computeDrawCommit(ids, "seed-2"), base, "seed matters");
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("drawJudge: deterministic for (pool,seed,salt); empty pool denied", () => {
  const ids = ["local-qwen/a", "local-qwen/b", "local-qwen/c"];
  const d1 = drawJudge(ids, "s", "run-1");
  const d2 = drawJudge(ids, "s", "run-1");
  assert.ok(d1.ok && d2.ok);
  if (!d1.ok || !d2.ok) return;
  assert.deepEqual(d1.draw, d2.draw);
  assert.ok(d1.draw.index >= 0 && d1.draw.index < ids.length);
  assert.equal(d1.draw.modelId, ids[d1.draw.index]);
  assert.equal(d1.draw.drawCommit, computeDrawCommit(ids, "s"));
  // different salts spread over the pool (sanity: not always index 0)
  const seen = new Set<number>();
  for (let i = 0; i < 24; i++) {
    const d = drawJudge(ids, "s", `salt-${String(i)}`);
    assert.ok(d.ok);
    if (d.ok) seen.add(d.draw.index);
  }
  assert.ok(seen.size >= 2, "draw must vary with salt across a small sample");
  assert.ok(!drawJudge([], "s", "x").ok);
});

test("toModelId shape", () => {
  assert.equal(toModelId({ providerID: "p", modelID: "m" }), "p/m");
});
