// provenance: W1 convener-recusal locks. Kinship is engine-resolved: parent
// chains via session.get, drafting evidence via tool parts in session.messages.
// Locked: chain order to root; path + inline drafting hits (write/edit,
// assistant paste); the MIN_INLINE_MATCH false-positive gate; every unreadable
// surface yields UNVERIFIABLE with a named reason (never a silent INDEPENDENT);
// cycle and depth caps keep the walk finite.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EngineClient } from "../src/engine/index.ts";
import { assessIndependence, independenceLabel, MAX_CHAIN_DEPTH } from "../src/independence.ts";
import type { ArtifactInput } from "../src/tools/shared.ts";

type MsgRow = NonNullable<NonNullable<Awaited<ReturnType<NonNullable<EngineClient["session"]["messages"]>>>["data"]>[number]>;

type Mock = {
  client: EngineClient;
  sessions: Map<string, { parentID?: string; messages?: MsgRow[]; failGet?: boolean; failMessages?: boolean }>;
};

function mock(sessions: Mock["sessions"]): Mock {
  const client: EngineClient = {
    session: {
      async create() {
        return { data: { id: "unused" } };
      },
      async prompt() {
        return { data: { info: {}, parts: [] } };
      },
      async get(args) {
        const s = sessions.get(args.path.id);
        if (s === undefined || s.failGet === true) return { error: { message: `unknown session ${args.path.id}` } };
        return { data: { id: args.path.id, parentID: s.parentID ?? "" } };
      },
      async messages(args) {
        const s = sessions.get(args.path.id);
        if (s === undefined || s.failMessages === true) return { error: { message: "messages refused" } };
        return { data: s.messages ?? [] };
      },
    },
  };
  return { client, sessions };
}

function writePart(tool: string, input: Record<string, unknown>): MsgRow {
  return { info: { role: "assistant" }, parts: [{ type: "tool", tool, input }] };
}

function textPart(text: string): MsgRow {
  return { info: { role: "assistant" }, parts: [{ type: "text", text }] };
}

const PATH_ARTIFACT: ArtifactInput = { ok: true, kind: "path", source: "/work/proposal.md", text: "body" };
const INLINE_TEXT = "x".repeat(100);
const INLINE_ARTIFACT: ArtifactInput = { ok: true, kind: "inline", source: "<inline: 100 bytes>", text: INLINE_TEXT };

test("clean chain to root with no drafting evidence => INDEPENDENT, full chain recorded", async () => {
  const m = mock(new Map([
    ["ses_c", { parentID: "ses_p" }],
    ["ses_p", { parentID: "ses_r" }],
    ["ses_r", {}],
  ]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "INDEPENDENT");
  assert.deepEqual(v.convenerChain, ["ses_c", "ses_p", "ses_r"]);
  assert.match(v.evidence, /scanned 3 session\(s\)/);
});

test("artifact written by the convener itself => NOT-INDEPENDENT with session+position", async () => {
  const m = mock(new Map([["ses_c", { messages: [writePart("write", { filePath: "/work/proposal.md", content: "body" })] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /drafting evidence: write on \/work\/proposal\.md in convener-chain session ses_c \(chain position 0/);
});

test("artifact written by an ANCESTOR (the charter incident shape) => NOT-INDEPENDENT", async () => {
  const m = mock(new Map([
    ["ses_c", { parentID: "ses_draft" }],
    ["ses_draft", { messages: [writePart("edit", { filePath: "/work/proposal.md", oldString: "a", newString: "b" })] }],
  ]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /session ses_draft \(chain position 1/);
});

test("inline artifact: write content matching / containing => NOT-INDEPENDENT", async () => {
  const m = mock(new Map([["ses_c", { messages: [writePart("write", { filePath: "/work/draft.md", content: `header\n${INLINE_TEXT}\nfooter` })] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", INLINE_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /content matches the inline artifact/);
});

test("inline artifact: author pasted it in assistant text => NOT-INDEPENDENT", async () => {
  const m = mock(new Map([["ses_c", { messages: [textPart(`let me draft:\n${INLINE_TEXT}\n— done`)] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", INLINE_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /assistant text/);
});

test("false-positive gate: short inline only matches EXACTLY; substring of unrelated content passes", async () => {
  const short: ArtifactInput = { ok: true, kind: "inline", source: "<inline: 11 bytes>", text: "yes, please" };
  const m = mock(new Map([["ses_c", { messages: [writePart("write", { filePath: "/work/other.md", content: "a yes, please note in a long unrelated document about other things" })] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", short);
  assert.equal(v.status, "INDEPENDENT", v.evidence);
});

test("read scope respected: read/noise tools and OTHER paths do not trigger", async () => {
  const m = mock(new Map([["ses_c", { messages: [writePart("write", { filePath: "/work/something-else.md", content: "x" }), writePart("bash", { command: "cat /work/proposal.md" })] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "INDEPENDENT");
});

test("headless invocation => UNVERIFIABLE naming the missing convener", async () => {
  const m = mock(new Map());
  const v = await assessIndependence(m.client, "/work", "", PATH_ARTIFACT);
  assert.equal(v.status, "UNVERIFIABLE");
  assert.match(v.evidence, /headless invocation/);
});

test("no session.get seam => UNVERIFIABLE (never a silent INDEPENDENT)", async () => {
  const bare: EngineClient = {
    session: {
      async create() { return { data: { id: "x" } }; },
      async prompt() { return { data: { info: {}, parts: [] } }; },
    },
  };
  const v = await assessIndependence(bare, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "UNVERIFIABLE");
  assert.match(v.evidence, /no session\.get seam/);
});

test("mid-walk store refusal => UNVERIFIABLE with the partial chain + not-established wording", async () => {
  const m = mock(new Map([["ses_c", { parentID: "ses_ghost" }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "UNVERIFIABLE");
  assert.deepEqual(v.convenerChain, ["ses_c", "ses_ghost"]);
  assert.match(v.evidence, /partial read/);
  assert.match(v.evidence, /independence was NOT established/);
});

test("messages refusal on a chain member => UNVERIFIABLE (unreadable is not clean)", async () => {
  const m = mock(new Map([["ses_c", { failMessages: true }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", PATH_ARTIFACT);
  assert.equal(v.status, "UNVERIFIABLE");
  assert.match(v.evidence, /messages\(ses_c\) refused/);
});

test("cycle in the store stops the walk (finite), scan proceeds over the seen chain", async () => {
  const m = mock(new Map([
    ["a", { parentID: "b" }],
    ["b", { parentID: "a" }],
  ]));
  const v = await assessIndependence(m.client, "/work", "a", PATH_ARTIFACT);
  assert.deepEqual(v.convenerChain, ["a", "b"]);
  assert.equal(v.status, "INDEPENDENT"); // cycle stops re-visiting; members scanned clean
  assert.match(v.evidence, /walk note: cycle at a/); // the anomaly stays visible on the face
});

test("depth cap holds: a long chain terminates at MAX_CHAIN_DEPTH", async () => {
  const sessions = new Map<string, { parentID?: string }>();
  for (let i = 0; i < MAX_CHAIN_DEPTH + 5; i += 1) sessions.set(`s${String(i)}`, { parentID: `s${String(i + 1)}` });
  sessions.set(`s${String(MAX_CHAIN_DEPTH + 5)}`, {});
  const m = mock(sessions as Mock["sessions"]);
  const v = await assessIndependence(m.client, "/work", "s0", PATH_ARTIFACT);
  // self + one parent per walk step, capped at MAX_CHAIN_DEPTH steps
  assert.equal(v.convenerChain.length, MAX_CHAIN_DEPTH + 1);
});

test("independenceLabel renders the face: quiet for INDEPENDENT, loud otherwise", () => {
  assert.equal(independenceLabel({ status: "INDEPENDENT", convenerChain: ["a"], evidence: "clean" }), "independence=INDEPENDENT");
  const loud = independenceLabel({ status: "NOT-INDEPENDENT", convenerChain: ["a"], evidence: "drafted by a" });
  assert.match(loud, /^independence=NOT-INDEPENDENT — drafted by a$/);
});

test("chamber record validation carries the independence leg and refuses bad shapes", async () => {
  const { validateChamberRecord } = await import("../src/state/chamber.ts");
  const base = {
    schema: 1, runId: "r", serial: 1, profile: "review", goal: "g", target: "/t", runDir: "/abs/run",
    createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", terminal: null,
    roster: [], judgePool: [], seed: "s", drawCommit: "0".repeat(64), judgeModelId: "m",
    rounds: 0, artifacts: [], evidenceRows: 0,
  };
  const good = { ...base, independence: { status: "NOT-INDEPENDENT", convenerChain: ["a", "b"], evidence: "kin" } };
  const v = validateChamberRecord(good);
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepEqual(v.ok ? v.record.independence : undefined, good.independence);
  assert.ok(!validateChamberRecord({ ...base, independence: { status: "GUILTY", convenerChain: [], evidence: "" } }).ok);
  assert.ok(!validateChamberRecord({ ...base, independence: { status: "INDEPENDENT", convenerChain: [""], evidence: "x" } }).ok);
});
