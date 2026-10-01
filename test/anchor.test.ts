// provenance: g12b-3 anchor validator tests — scripted mock client, mirroring
// test/engine.test.ts conventions (runtime shapes; exactOptionalPropertyTypes:
// absent keys are OMITTED, never written as undefined).

import { test } from "node:test";
import assert from "node:assert/strict";

import { anchorExecute, decide, sha256, canonicalView } from "../src/tools/anchor.ts";
import type { ToolDeps } from "../src/tools/shared.ts";
import type { EngineClient } from "../src/engine/index.ts";

const BODY = "同意";
const BODY_SHA = sha256(BODY);

function mk(rows: unknown[], withMessages = true): ToolDeps {
  const messages = withMessages
    ? async () => ({ data: rows })
    : undefined;
  const client = {
    session: { ...(messages !== undefined ? { messages } : {}) },
  } as unknown as EngineClient;
  return { client, store: {} as ToolDeps["store"], options: {} as ToolDeps["options"] };
}

const ctx = { directory: "/tmp/x", abort: new AbortController().signal, sessionID: "ses_caller" };

const humanMsg = { info: { role: "user", time: { completed: 1 } }, parts: [{ type: "text", text: BODY }, { type: "step-start" }] };

test("decide: closed 4-state on pure inputs", () => {
  assert.equal(decide(humanMsg, BODY_SHA).verdict, "MATCH");
  assert.equal(decide(humanMsg, sha256("不同意")).verdict, "MISMATCH");
  assert.equal(decide(undefined, BODY_SHA).verdict, "ABSENT");
});

test("MATCH receipt carries claim, anchor and view hashes", async () => {
  const out = await anchorExecute(mk([humanMsg]), { sessionId: "s", expectSha256: BODY_SHA, label: "ratify-A" }, ctx);
  assert.match(out, /^SIBYL ANCHOR MATCH$/m);
  assert.match(out, new RegExp(`anchor_sha256=${BODY_SHA}`));
  assert.match(out, /view_sha256=[0-9a-f]{64}/);
  assert.match(out, /label=ratify-A/);
  assert.match(out, /role=user/);
});

test("MISMATCH on wrong claim; hex shape stays case-insensitive", async () => {
  const out = await anchorExecute(mk([humanMsg]), { sessionId: "s", expectSha256: sha256("别的").toUpperCase() }, ctx);
  assert.match(out, /SIBYL ANCHOR MISMATCH/);
});

test("out-of-range index => ABSENT, not a crash", async () => {
  const out = await anchorExecute(mk([humanMsg]), { sessionId: "s", index: 9, expectSha256: BODY_SHA }, ctx);
  assert.match(out, /SIBYL ANCHOR ABSENT/);
  assert.match(out, /anchor_sha256=-/);
});

test("no claim supplied => ERROR(honest non-verdict), content unasserted", async () => {
  const out = await anchorExecute(mk([humanMsg]), { sessionId: "s" }, ctx);
  assert.match(out, /SIBYL ANCHOR ERROR/);
  assert.match(out, /no expectSha256/);
});

test("malformed claim is ERROR (cannot-answer), never MISMATCH", async () => {
  const out = await anchorExecute(mk([humanMsg]), { sessionId: "s", expectSha256: "z".repeat(64) }, ctx);
  assert.match(out, /ANCHOR: ERROR — expectSha256 must be 64 hex/);
});

test("engine read error surfaces as ERROR receipt", async () => {
  const deps = mk([], false);
  const out = await anchorExecute(deps, { sessionId: "s", expectSha256: BODY_SHA }, ctx);
  assert.match(out, /ANCHOR: ERROR — engine client exposes no session.messages/);
});

test("view hash ignores fields outside the verdict surface (time noise)", () => {
  const a = canonicalView([{ info: { role: "user" }, parts: [{ type: "text", text: BODY }] }]);
  const b = canonicalView([{ info: { role: "user", time: { completed: 2 } }, parts: [{ type: "text", text: BODY }, { type: "step-start" }] }]);
  assert.notEqual(sha256(a), sha256(b)); // parts differ => view differs
  const c = canonicalView([{ info: { role: "user", modelID: "x" }, parts: [{ type: "text", text: BODY }] }]);
  assert.equal(sha256(a), sha256(c)); // modelID noise outside canonical shape => stable
});

test("negative index counts from the end", async () => {
  const out = await anchorExecute(mk([humanMsg, humanMsg]), { sessionId: "s", index: -1, expectSha256: BODY_SHA }, ctx);
  assert.match(out, /SIBYL ANCHOR MATCH/);
  assert.match(out, /messages=2/);
});
