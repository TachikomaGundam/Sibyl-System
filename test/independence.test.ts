// provenance: W1 convener-recusal locks. Kinship is engine-resolved: parent
// chains via session.get, drafting evidence via tool parts in session.messages.
// Locked: chain order to root; path + inline drafting hits (write/edit,
// assistant paste); the MIN_INLINE_MATCH false-positive gate; every unreadable
// surface yields UNVERIFIABLE with a named reason (never a silent INDEPENDENT);
// cycle and depth caps keep the walk finite.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EngineClient } from "../src/engine/index.ts";
import { assessIndependence, independenceLabel, LINEAGE_CHUNK, MAX_CHAIN_DEPTH } from "../src/independence.ts";
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

// ---------------------------------------------------------------- v2 lineage

function timedPart(tool: string, input: Record<string, unknown>, created: number): MsgRow {
  return { info: { role: "assistant", time: { created } }, parts: [{ type: "tool", tool, input }] } as unknown as MsgRow;
}

function doc(seed: string, chunks: number): string {
  return Array.from({ length: chunks }, (_, i) => `${seed}${String(i)}:`.padEnd(LINEAGE_CHUNK, `${i}`)).join("");
}

const MTIME = 1_000_000;
const LONG_DOC = doc("lineage-body-", 10);
const LONG_ARTIFACT: ArtifactInput = {
  ok: true, kind: "path", source: "/work/long.md", text: LONG_DOC, mtimeMs: MTIME,
};
// need = ceil(32 samples? -> windows: floor(2560/256)=10, step 1, samples 10) * 0.6 = 6
test("v2: verbatim full text written under a DIFFERENT path before mtime => NOT-INDEPENDENT (526d case)", async () => {
  const m = mock(new Map([["ses_c", {
    messages: [timedPart("write", { filePath: "/tmp/clone/long.md", content: LONG_DOC }, MTIME - 10)],
  }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /content-lineage|full-text containment/);
});

test("v2: bash heredoc carrying the artifact verbatim before mtime => NOT-INDEPENDENT (F-W1a)", async () => {
  const cmd = `cat <<'EOF' > /work/long.md\n${LONG_DOC}\nEOF`;
  const m = mock(new Map([["ses_c", { messages: [timedPart("bash", { command: cmd }, MTIME - 1)] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
});

test("v2: partial copy-from-file AFTER mtime never convicts (false-conviction gate)", async () => {
  const m = mock(new Map([["ses_c", {
    messages: [timedPart("write", { filePath: "/work/notes.md", content: LONG_DOC }, MTIME + 10)],
  }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "INDEPENDENT");
  assert.match(v.evidence, /post-mtime copies/);
});

test("v2: template boilerplate (2 of 10 windows) is a minority => INDEPENDENT with confessed count", async () => {
  const template = `${LONG_DOC.slice(0, LINEAGE_CHUNK)}TAIL${LONG_DOC.slice(LINEAGE_CHUNK, 2 * LINEAGE_CHUNK)}TAIL`;
  const m = mock(new Map([["ses_c", {
    messages: [timedPart("write", { filePath: "/work/fresh.md", content: template }, MTIME - 5)],
  }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "INDEPENDENT");
  assert.match(v.evidence, /2\/10 distinct lineage windows matched \(majority need 6/);
});

test("v2: union across several parts reaches the majority => NOT-INDEPENDENT", async () => {
  const parts: MsgRow[] = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    timedPart("edit", { filePath: `/work/slice-${String(i)}.tmp`, newString: LONG_DOC.slice(i * LINEAGE_CHUNK, (i + 1) * LINEAGE_CHUNK) }, MTIME - 100 + i));
  const m = mock(new Map([["ses_c", { messages: parts }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "NOT-INDEPENDENT");
});

test("v2: timeless parts are never credited (precedence unprovable) and are confessed", async () => {
  const m = mock(new Map([["ses_c", { messages: [writePart("write", { filePath: "/work/x.md", content: LONG_DOC })] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", LONG_ARTIFACT);
  assert.equal(v.status, "INDEPENDENT");
  assert.match(v.evidence, /lacked timestamps/);
});

test("v2: artifact shorter than 3 windows keeps the lineage leg silent", async () => {
  const tiny: ArtifactInput = { ok: true, kind: "path", source: "/work/t.md", text: "x".repeat(400), mtimeMs: MTIME };
  const m = mock(new Map([["ses_c", { messages: [timedPart("bash", { command: `x`.repeat(400) }, MTIME - 1)] }]]));
  const v = await assessIndependence(m.client, "/work", "ses_c", tiny);
  assert.equal(v.status, "INDEPENDENT");
  assert.doesNotMatch(v.evidence, /lineage/);
});

// ——— calibration locks (lineage-calibration-20261014): the law is
// majority-of-bytes OR full containment; minorities read independent by design.

function bigText(kb: number): string {
  let t = "";
  let i = 0;
  while (t.length < kb * 1024) { t += `chunk-${String(i)}:`.padEnd(260, String(i)) + "\n"; i += 1; }
  return t;
}
const BIG = bigText(12);

test("full containment under another path convicts with the honest sentence", async () => {
  const m = mock(new Map([["ses_c", { messages: [timedWrite("write", { filePath: "/tmp/clone/x.md", content: BIG }, 1000)] }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: BIG, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /the FULL text of \/work\/a\.md appears verbatim/);
  assert.doesNotMatch(v.evidence, /1 of \d+ windows/); // F2 cosmetic: no misleading window count on the instant path
});

test("overlapping-window majority (8 parts x 2.4KB, 80% coverage) convicts via union", async () => {
  const parts = Array.from({ length: 8 }, (_, i) =>
    timedWrite("write", { filePath: `/w/p${String(i)}.md`, content: BIG.slice(i * 1200, i * 1200 + 2400) }, 1000),
  );
  const m = mock(new Map([["ses_c", { messages: parts }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: BIG, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /of \d+ DISTINCT verbatim 256-byte windows/); // F1: ceil-stride spreads windows across the WHOLE artifact
});

test("fragmented minority (25%) stays independent — the ratio is the law", async () => {
  const parts = Array.from({ length: 4 }, (_, i) =>
    timedWrite("write", { filePath: `/w/q${String(i)}.md`, content: BIG.slice(i * 768, (i + 1) * 768) }, 1000),
  );
  const m = mock(new Map([["ses_c", { messages: parts }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: BIG, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "INDEPENDENT");
});

function timedWrite(tool: string, input: Record<string, unknown>, time: number): MsgRow {
  return { info: { role: "assistant", time: { created: time } }, parts: [{ type: "tool", tool, input }] };
}

// ——— regression pin for calibration finding F1 (lineage-calibration-20261014):
// floor-stride on MID-SIZE artifacts (48..63 windows) collapsed to step 1, so
// sampling watched only the first 8KB. 12KB artifact; the chain drafted the last
// ~8.3KB under another path. Old ruler: 16 of 32 matched, need 20 -> INDEPENDENT
// (the blind spot). New ruler: 16 of 24, need 15 -> NOT-INDEPENDENT.
// Mutation-verified both ways 2026-10-14.
test("latter-67% drafting convicts (mid-size head-only sampler regression pin)", async () => {
  const mid = bigText(12);
  const part = timedWrite("write", { filePath: "/w/tail.md", content: mid.slice(4000) }, 1000);
  const m = mock(new Map([["ses_c", { messages: [part] }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: mid, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /of \d+ DISTINCT verbatim 256-byte windows/);
});

// ——— v1.3.6 law deltas: dedupe (repetition inflation) + absolute floor (ratio evasion),
// both surfaced by ballots 6eea/bbaf; each pinned with the failure it kills.
test("repeated identical rows count ONCE (dedupe defense)", async () => {
  const row = "DUP-ROW:" + "z".repeat(247) + "\n";
  const art = row.repeat(60);
  const part = timedWrite("write", { filePath: "/w/seed.md", content: row }, 1000);
  const m = mock(new Map([["ses_c", { messages: [part] }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: art, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "INDEPENDENT");
});

test("absolute floor: ~40% distinct-typed drafting convicts below the majority line", async () => {
  let head = "";
  for (let i = 0; i < 18; i += 1) head += `H${String(i).padStart(3, "0")}:` + String(i).repeat(254).slice(0, 249) + "\n";
  let typed = "";
  for (let i = 0; i < 20; i += 1) typed += `T${String(i).padStart(3, "0")}:` + String(i * 7 + 1).repeat(254).slice(0, 249) + "\n";
  let rest = "";
  for (let i = 0; i < 10; i += 1) rest += `R${String(i).padStart(3, "0")}:` + String(i * 3 + 2).repeat(254).slice(0, 249) + "\n";
  const art = head + typed + rest;
  const part = timedWrite("write", { filePath: "/w/typed.md", content: typed }, 1000);
  const m = mock(new Map([["ses_c", { messages: [part] }]]));
  const v = await assessIndependence(m.client, "/w", "ses_c", { ok: true, kind: "path", source: "/work/a.md", text: art, mtimeMs: 9_000_000_000_000 });
  assert.equal(v.status, "NOT-INDEPENDENT");
  assert.match(v.evidence, /absolute floor of drafting/);
});

test("previewLineage dry-runs the exact law offline (stage-check core)", async () => {
  const { previewLineage } = await import("../src/independence.ts");
  let text = "";
  for (let i = 0; i < 40; i += 1) text += `P${String(i).padStart(3, "0")}:` + String(i * 11).repeat(254).slice(0, 249) + "\n";
  const parts = [{ time: 500, cands: [text.slice(0, 1500)] }];
  const r = previewLineage(text, 10_000, parts);
  assert.equal(r.status, "WOULD-READ-INDEPENDENT");
  const r2 = previewLineage(text, 10_000, [{ time: 500, cands: [text] }]);
  assert.equal(r2.status, "WOULD-CONVICT");
});
