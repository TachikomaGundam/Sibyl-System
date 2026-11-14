// H1 reclaim wheel tests: tracking collector, evidence-first delete, skip/
// dead-letter semantics, manifest shapes, child-first ordering, sweep planner,
// manifest-mode CLI gates (spawned, dry + refused batches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { reclaimRunSessions, trackingClient } from "../src/tools/reclaim.ts";
import { readDeleteSet, orderChildFirst } from "../scripts/session-reap.mjs";
import { planSweep, moveDir } from "../scripts/gc-run-dirs.mjs";

// These fakes implement only the session methods the reclaim module touches.
// EngineClient's prompt bag is stubbed with an empty result: reclaim never
// prompts. (No `as any` anywhere — the shapes below satisfy the type.)
function fakeClient(
  events: string[],
  opts: { existing?: Set<string>; failIds?: string[]; noDelete?: boolean } = {},
) {
  const created = ["S1", "S2", "S3"];
  let i = 0;
  const existing = new Set(opts.existing ?? created);
  return {
    session: {
      create: async () => {
        const id = created[i] ?? `SX${String(i)}`;
        i += 1;
        existing.add(id);
        events.push(`create:${id}`);
        return { data: { id } };
      },
      prompt: async () => ({}),
      messages: async () => ({}),
      ...(opts.noDelete ? {} : {
        delete: async ({ path }: { path: { id: string } }) => {
          events.push(`delete:${path.id}`);
          if (opts.failIds?.includes(path.id)) return { error: { name: "EngineError", message: `boom for ${path.id}` } };
          if (!existing.has(path.id)) return { error: { name: "NotFoundError", message: `Session not found: ${path.id}` } };
          existing.delete(path.id);
          return {};
        },
      }),
    },
  };
}

async function space(withTerminals = true) {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-reclaim-"));
  await writeFile(join(dir, "MELCHIOR.md"), "ballot one", "utf8");
  if (withTerminals) await writeFile(join(dir, "TERMINALS.txt"), "row\n", "utf8");
  return dir;
}

test("trackingClient registers created ids only", async () => {
  const events: string[] = [];
  const sink = new Set<string>();
  const wrapped = trackingClient(fakeClient(events), sink);
  await wrapped.session.create({ body: { title: "t" }, query: { directory: "/d" } });
  await wrapped.session.create({ body: { title: "t" }, query: { directory: "/d" } });
  assert.deepEqual([...sink], ["S1", "S2"]);
});

test("reclaim: evidence-first, reverse-order delete, manifest + checksums", async () => {
  const events: string[] = [];
  const dir = await space();
  const client = fakeClient(events);
  const out = await reclaimRunSessions({
    client,
    directory: "/d",
    spaceDir: dir,
    retainSessions: false,
    entries: [
      { sessionId: "S1", artifactPaths: [join(dir, "TERMINALS.txt"), join(dir, "MELCHIOR.md")] },
      { sessionId: "S2", artifactPaths: [join(dir, "TERMINALS.txt")] },
    ],
    evidencePaths: [join(dir, "TERMINALS.txt"), join(dir, "MELCHIOR.md")],
  });
  assert.equal(out.ran, true);
  assert.deepEqual(out.deleted, ["S2", "S1"]); // reverse creation order: children first
  assert.equal(out.failed.length, 0);
  // reverse creation order: S2 before S1
  assert.deepEqual(events.filter((e) => e.startsWith("delete:")), ["delete:S2", "delete:S1"]);
  const rows = (await readFile(join(dir, "SESSIONS.json"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "deleted");
  assert.equal(rows[0].deleted, true);
  assert.match(rows[0].artifacts[0].sha256, /^[0-9a-f]{64}$/);
  const sums = await readFile(join(dir, "CHECKSUMS.txt"), "utf8");
  assert.match(sums, /MELCHIOR\.md$/m);
  assert.match(sums, /SESSIONS\.json$/m);
});

test("reclaim: retainSessions keeps everything and records the reason", async () => {
  const events: string[] = [];
  const dir = await space();
  const out = await reclaimRunSessions({
    client: fakeClient(events),
    directory: "/d",
    spaceDir: dir,
    retainSessions: true,
    entries: [{ sessionId: "S1", artifactPaths: [join(dir, "TERMINALS.txt")] }],
    evidencePaths: [],
  });
  assert.equal(out.ran, false);
  assert.equal(out.reason, "retainSessions");
  assert.deepEqual(events, []);
});

test("reclaim: missing evidence skips that session only", async () => {
  const events: string[] = [];
  const dir = await space();
  const out = await reclaimRunSessions({
    client: fakeClient(events),
    directory: "/d",
    spaceDir: dir,
    retainSessions: false,
    entries: [
      { sessionId: "S1", artifactPaths: [join(dir, "NOPE.md")] },
      { sessionId: "S2", artifactPaths: [join(dir, "TERMINALS.txt")] },
    ],
    evidencePaths: [join(dir, "TERMINALS.txt")],
  });
  assert.deepEqual(out.deleted, ["S2"]);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0]!.reason, /^evidence-missing:/);
});

test("reclaim: engine errors dead-letter; not-found counts deleted", async () => {
  const events: string[] = [];
  const dir = await space();
  const client = fakeClient(events, { failIds: ["S2"] });
  const out = await reclaimRunSessions({
    client,
    directory: "/d",
    spaceDir: dir,
    retainSessions: false,
    entries: [
      { sessionId: "S1", artifactPaths: [join(dir, "TERMINALS.txt")] },
      { sessionId: "S2", artifactPaths: [join(dir, "TERMINALS.txt")] },
    ],
    evidencePaths: [join(dir, "TERMINALS.txt")],
  });
  assert.deepEqual(out.deleted, ["S1"]);
  assert.equal(out.failed.length, 1);
  const dl = (await readFile(join(dir, "DEAD-LETTER.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(dl[0].sessionId, "S2");
  // idempotent replay: second pass sees not-found -> still "deleted"
  const out2 = await reclaimRunSessions({
    client: fakeClient([], { existing: new Set() }),
    directory: "/d",
    spaceDir: dir,
    retainSessions: false,
    entries: [{ sessionId: "S1", artifactPaths: [join(dir, "TERMINALS.txt")] }],
    evidencePaths: [join(dir, "TERMINALS.txt")],
  });
  assert.deepEqual(out2.deleted, ["S1"]);
  assert.equal(out2.failed.length, 0);
});

test("reclaim: absent delete channel skips everything", async () => {
  const events: string[] = [];
  const dir = await space();
  const out = await reclaimRunSessions({
    client: fakeClient(events, { noDelete: true }),
    directory: "/d",
    spaceDir: dir,
    retainSessions: false,
    entries: [{ sessionId: "S1", artifactPaths: [join(dir, "TERMINALS.txt")] }],
    evidencePaths: [],
  });
  assert.equal(out.ran, false);
  assert.equal(out.reason, "engine-delete-unavailable");
  assert.equal(out.skipped.length, 1);
});

test("readDeleteSet: manifest + dead-letter shapes, dedupe, corrupt refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-rd-"));
  const good = join(dir, "m.jsonl");
  await writeFile(
    good,
    [
      JSON.stringify({ action: "delete", id: "A" }),
      JSON.stringify({ action: "keep", id: "B" }),
      JSON.stringify({ sessionId: "A" }),
      JSON.stringify({ sessionId: "C", reason: "x" }),
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(readDeleteSet(good), [
    { id: "A", source: "manifest" },
    { id: "C", source: "dead-letter" },
  ]);
  const bad = join(dir, "bad.jsonl");
  await writeFile(bad, "{oops\n", "utf8");
  assert.throws(() => readDeleteSet(bad), /not valid JSON/);
});

test("orderChildFirst: grandchildren before children before parents", () => {
  const parents = new Map([
    ["grand", null],
    ["parent", "grand"],
    ["kid", "parent"],
    ["other", null],
  ]);
  const ordered = orderChildFirst(["grand", "parent", "kid", "other"], parents);
  assert.ok(ordered.indexOf("kid") < ordered.indexOf("parent"));
  assert.ok(ordered.indexOf("parent") < ordered.indexOf("grand"));
});

type SweepPlanRow = { name: string; action: string; reason: string };

test("planSweep: only sealed + terminal + past-grace moves", () => {
  const plan: SweepPlanRow[] = planSweep(
    [
      { name: "ok", uidOk: true, sealed: true, terminal: true, ageMs: 999_999_999 },
      { name: "young", uidOk: true, sealed: true, terminal: true, ageMs: 0 },
      { name: "unsealed", uidOk: true, sealed: false, terminal: true, ageMs: 999_999_999 },
      { name: "running", uidOk: true, sealed: true, terminal: false, ageMs: 999_999_999 },
      { name: "foreign", uidOk: false, sealed: true, terminal: true, ageMs: 999_999_999 },
    ],
    { olderThanMs: 3_600_000 },
  );
  assert.equal(plan.find((p) => p.name === "ok")!.action, "move");
  for (const n of ["young", "unsealed", "running", "foreign"]) assert.equal(plan.find((p) => p.name === n)!.action, "keep");
});

test("moveDir: plain move + collision suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "sibyl-gc-"));
  const src = join(root, "sibyl-run-x");
  const archive = join(root, "archive");
  await mkdir(src);
  await writeFile(join(src, "CHECKSUMS.txt"), "x", "utf8");
  const dest = await moveDir(src, archive);
  assert.equal(dest, join(archive, "sibyl-run-x"));
  await stat(src).then(() => assert.fail("src still exists"), () => undefined);
  await mkdir(src);
  await moveDir(src, archive); // collision path
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(archive));
  assert.equal(entries.length, 2);
});

function fixtureDb(path: string, rows: { id: string; title: string; t: number; parent_id?: string | null }[]) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)");
  const ins = db.prepare("INSERT INTO session_v2 (id, title, parent_id, time_created, time_updated) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(r.id, r.title, r.parent_id ?? null, r.t ?? 1, r.t ?? 1);
  db.close();
}

function runReap(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "session-reap.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENCODE_BIN: "/usr/bin/true", ...env },
    timeout: 30_000,
  });
}

test("reap --manifest: dry-run counts + absent rows; gates refuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-reap-"));
  const db = join(dir, "store.db");
  const now = Date.now();
  fixtureDb(db, [
    { id: "A", title: "sibyl:persona MELCHIOR", t: now },
    { id: "B", title: "sibyl:audit convener", t: now },
    { id: "H", title: "human side chat", t: now },
  ]);
  const manifest = join(dir, "frozen.jsonl");
  await writeFile(
    manifest,
    [
      JSON.stringify({ action: "delete", id: "A" }),
      JSON.stringify({ action: "delete", id: "B" }),
      JSON.stringify({ sessionId: "GONE" }),
    ].join("\n"),
    "utf8",
  );
  const dry = runReap([`--db=${db}`, `--manifest=${manifest}`, `--manifest-dir=${join(dir, "md")}`, "--owner-ruling"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /rows=3 to-delete=2 absent=1/);
  assert.match(dry.stdout, /DRY-RUN/);
  // audit root without --owner-ruling refuses the batch
  const refused = runReap([`--db=${db}`, `--manifest=${manifest}`, `--manifest-dir=${join(dir, "md2")}`, "--apply"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /audit root/);
  // out-of-family id refuses
  await writeFile(manifest, JSON.stringify({ action: "delete", id: "H" }) + "\n", "utf8");
  const refused2 = runReap([`--db=${db}`, `--manifest=${manifest}`, `--manifest-dir=${join(dir, "md3")}`, "--apply"]);
  assert.equal(refused2.status, 1);
  assert.match(refused2.stderr + refused2.stdout, /outside the Sibyl family/);
  // authorized apply: OPENCODE_BIN=true -> deletion "succeeds" per the CLI channel
  await writeFile(manifest, JSON.stringify({ action: "delete", id: "A" }) + "\n", "utf8");
  const applied = runReap([`--db=${db}`, `--manifest=${manifest}`, `--manifest-dir=${join(dir, "md4")}`, "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /ok=1 failed=0/);
});
