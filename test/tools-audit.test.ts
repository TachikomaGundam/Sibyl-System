// sibyl_audit locks: the outside lane as a product organ. Happy path emits a
// receipt (run id, 2A/1R counts, fresh-root auditor, requested-by as DATA,
// sha256-bound bytes); planted kinship, a missing get seam, a failed
// provisioning, and mid-flight artifact drift each yield NO receipt
// (REFUSED/VOID). Rules follow L-BLIND-AUDIT: the auditor must not be the caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineClient } from "../src/engine/index.ts";
import { auditExecute } from "../src/tools/audit.ts";
import { parseOptions } from "../src/options.ts";
import type { PluginOptions } from "../src/options.ts";
import { RunStore } from "../src/state/index.ts";
import type { ToolContextLike, ToolDeps } from "../src/tools/shared.ts";

const verdict = (v: "APPROVE" | "REJECT", confidence: number, reason: string): string =>
  JSON.stringify({ verdict: v, confidence, reasons: [reason], must_fix: [] });

const BAL_A = verdict("APPROVE", 0.8, "a: ships");
const BAL_B = verdict("APPROVE", 0.8, "b: ships");
const BAL_C = verdict("REJECT", 0.7, "c: utility thin");

function options(raw: unknown): PluginOptions {
  const p = parseOptions(raw);
  assert.ok(p.ok, JSON.stringify(p));
  return p.options;
}

type AuditMock = {
  client: EngineClient;
  created: { title: string; parentID?: string }[];
  promptIds: string[];
  onFirstPrompt?: () => Promise<void> | void;
};

function auditMock(o: {
  auditorMessages?: unknown[];
  withGet?: boolean;
  failCreate?: boolean;
}): AuditMock {
  const state: AuditMock = { client: undefined as unknown as EngineClient, created: [], promptIds: [] };
  let n = 0;
  const ballots: Record<string, string> = { "sess-2": BAL_A, "sess-3": BAL_B, "sess-4": BAL_C };
  const client: EngineClient = {
    session: {
      async create(args) {
        if (o.failCreate === true) return { error: { message: "engine down" } };
        n += 1;
        const id = `sess-${String(n)}`;
        state.created.push({ title: args.body.title, ...(args.body.parentID !== undefined && { parentID: args.body.parentID }) });
        return { data: { id } };
      },
      async prompt(args) {
        const id = args.path.id;
        if (state.promptIds.length === 0 && state.onFirstPrompt !== undefined) await state.onFirstPrompt();
        state.promptIds.push(id);
        const text = ballots[id] ?? "";
        return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text }] } };
      },
      ...(o.withGet === false
        ? {}
        : {
            async get(args) {
              return { data: { id: args.path.id, parentID: "" } };
            },
          }),
      async messages(args) {
        if (args.path.id === "sess-1" && o.auditorMessages !== undefined) {
          return { data: o.auditorMessages as never };
        }
        return { data: [] };
      },
    },
  };
  state.client = client;
  return state;
}

async function fixture(): Promise<{ deps: (mock: AuditMock) => ToolDeps; ctx: (artifactDir: string) => ToolContextLike; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-audit-"));
  const store = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: join(dir, "spaces") });
  return {
    deps: (mock) => ({ client: mock.client, store, options: options({ timeoutMs: 15_000 }) }),
    ctx: (artifactDir) => ({ directory: artifactDir, abort: new AbortController().signal, sessionID: "ses-caller-kin" }),
    dir,
  };
}

test("happy: receipt from a fresh root auditor; caller recorded as data only; ballot enters effective path", async () => {
  const fx = await fixture();
  const mock = auditMock({});
  const art = join(fx.dir, "target.md");
  await writeFile(art, "# target\n" + "body text that is comfortably long for hashing purposes.\n".repeat(8), "utf8");
  const out = await auditExecute(fx.deps(mock), { artifact: art, goal: "does this ship-ready doc hold?" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT RECEIPT run=sibyl-/);
  assert.match(out, /verdict=APPROVE \(2A\/1R\/0E\/0M\) rules=[0-9a-f]{12}/);
  assert.match(out, /auditor-convener=sess-1 \(fresh engine-provisioned root/);
  assert.match(out, /requested-by=ses-caller-kin — recorded as ledger data only/);
  assert.match(out, /artifact-sha256=[0-9a-f]{64} \(re-hashed after the ballot, identical/);
  // structural law: the auditor create carried NO parentID (fresh root), the
  // voters nested under the auditor — never under the caller.
  assert.equal(mock.created[0]?.parentID, undefined);
  assert.equal(mock.created[1]?.parentID, "sess-1");
});

test("bell (planted): kinship evidence in the auditor session => REFUSED, no receipt", async () => {
  const fx = await fixture();
  const art = join(fx.dir, "drafted.md");
  await writeFile(art, "content\n".repeat(40), "utf8");
  const planted = [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "write", input: { filePath: art, content: "x".repeat(200) } }] }];
  const mock = auditMock({ auditorMessages: planted });
  const out = await auditExecute(fx.deps(mock), { artifact: art, goal: "g" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT: REFUSED/);
  assert.match(out, /independence=NOT-INDEPENDENT/);
  assert.match(out, /archived as DATA and carries no audit receipt/);
});

test("no session.get seam => UNVERIFIABLE => REFUSED (absence of evidence is not an audit)", async () => {
  const fx = await fixture();
  const mock = auditMock({ withGet: false });
  const art = join(fx.dir, "u.md");
  await writeFile(art, "y".repeat(400), "utf8");
  const out = await auditExecute(fx.deps(mock), { artifact: art, goal: "g" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT: REFUSED/);
  assert.match(out, /independence=UNVERIFIABLE/);
});

test("engine refuses to provision the auditor => refused, no ballot runs", async () => {
  const fx = await fixture();
  const mock = auditMock({ failCreate: true });
  const out = await auditExecute(fx.deps(mock), { artifact: "some inline\nmulti-line content", goal: "g" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT: refused — engine did not provision/);
  assert.equal(mock.promptIds.length, 0);
});

test("drift: artifact bytes move mid-ballot => VOID receipt, bytes bind nothing", async () => {
  const fx = await fixture();
  const art = join(fx.dir, "moving.md");
  await writeFile(art, "stable bytes " + "x".repeat(300), "utf8");
  const mock = auditMock({});
  mock.onFirstPrompt = async () => {
    await writeFile(art, "mutated bytes " + "y".repeat(300), "utf8");
  };
  const out = await auditExecute(fx.deps(mock), { artifact: art, goal: "g" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT: VOID/);
  assert.match(out, /artifact bytes moved while the ballot was in flight/);
});

test("inline artifacts audit too (no path leg exists to hide behind)", async () => {
  const fx = await fixture();
  const mock = auditMock({});
  const inline = "an inline proposal\n" + "with enough lines to be a real artifact body.\n".repeat(6);
  const out = await auditExecute(fx.deps(mock), { artifact: inline, goal: "g" }, fx.ctx(fx.dir));
  assert.match(out, /^SIBYL AUDIT RECEIPT run=sibyl-/);
  assert.match(out, /artifact-sha256=[0-9a-f]{64}/);
});
