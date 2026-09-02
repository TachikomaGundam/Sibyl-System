// provenance: original clean-room Sibyl-System implementation (T5 state layer tests).
// Locks: roundtrip + order stability, element-validated load (malformed
// entries dropped with warnings, never fatal — swarm crash lesson), corrupt
// whole-file recovery, atomic concurrent appendOrUpdate (no torn JSON, no
// lost updates), createRun spaces, and the MANDATORY default-path assertion
// (learnings.md #4: NO env seam — the resolved path must literally be
// <repo>/.state/sibyl/runs.json, proven with a real write and byte-exact
// restore). All record assertions read the file back via a FRESH store
// instance (misleading-success guard), never in-memory state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RUNS_FILE,
  DEFAULT_SPACE_ROOT,
  SIBYL_STATE_FILE_ENV,
  PACKAGE_ROOT,
  RunStore,
  type RunRecord,
} from "../src/state/index.ts";

// Repo root derived from this file (test/ lives one level under it), so the
// default-path assertions hold on any checkout, not just the author machine.
const SIBYL = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function rec(runId: string, createdAt: string, status: RunRecord["status"] = "running"): RunRecord {
  return {
    runId,
    kind: "consult",
    artifact: `/repo/${runId}.md`,
    status,
    spaceDir: `/spaces/${runId}`,
    createdAt,
    updatedAt: createdAt,
  };
}

async function tmp(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sibyl-t5-${label}-`));
}

function errorLines(spy: { mock: { calls: { arguments: unknown[] }[] } }): string[] {
  return spy.mock.calls.map((c) => c.arguments.join(" "));
}

test("roundtrip: appendOrUpdate persists; a fresh store loads byte-truth records", async (t) => {
  const dir = await tmp("roundtrip");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "nested", "runs.json"); // save must mkdir -p parents
  const store = new RunStore({ runsFile, spaceRoot: dir });
  const early = { ...rec("run-early", "2026-08-01T00:00:00.000Z", "done"), goal: "ship", rounds: 3 };
  const late = rec("run-late", "2026-08-02T00:00:00.000Z");
  await store.appendOrUpdate(late);
  await store.appendOrUpdate(early); // older createdAt -> sorts first
  const loaded = await new RunStore({ runsFile, spaceRoot: dir }).load();
  assert.deepEqual(loaded, [early, late]);
  // update in place: same runId, new status; order stays createdAt-stable
  const updated: RunRecord = { ...early, status: "suspended" };
  await store.appendOrUpdate(updated);
  const loaded2 = await new RunStore({ runsFile, spaceRoot: dir }).load();
  assert.deepEqual(loaded2, [updated, late]);
});

test("order stability: equal createdAt keeps insertion order across updates", async (t) => {
  const dir = await tmp("order");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: dir });
  const a = rec("a", "2026-08-01T00:00:00.000Z");
  const b = rec("b", "2026-08-01T00:00:00.000Z");
  await store.appendOrUpdate(a);
  await store.appendOrUpdate(b);
  await store.appendOrUpdate({ ...a, status: "done" }); // update must not jump queue
  const loaded = await new RunStore({ runsFile: join(dir, "runs.json") }).load();
  assert.deepEqual(loaded.map((r) => r.runId), ["a", "b"]);
  assert.equal(loaded[0]?.status, "done");
});

test("element-validated load drops malformed entries with warnings, keeps good ones", async (t) => {
  const dir = await tmp("validate");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  const good1 = rec("good-1", "2026-08-01T00:00:00.000Z");
  const good2 = rec("good-2", "2026-08-02T00:00:00.000Z", "failed");
  const garbage: unknown[] = [
    good1,
    { ...good1, runId: 123 }, // numeric runId
    null,
    "x",
    { runId: "no-space", kind: "consult", artifact: "a", status: "running", createdAt: good1.createdAt },
    good2,
    { ...good1, runId: "bad-verdict", verdict: { verdict: "MAYBE", approvals: 1, rejects: 0, errors: 0, missing: 0 } },
    { ...good1, runId: "bad-kind", kind: "divine" },
    { ...good1, runId: "bad-date", createdAt: "not-a-date" },
  ];
  await writeFile(runsFile, JSON.stringify(garbage), "utf8");
  const spy = t.mock.method(console, "error");
  const loaded = await new RunStore({ runsFile }).load();
  assert.deepEqual(loaded, [good1, good2]);
  const lines = errorLines(spy);
  assert.equal(lines.length, 7, `expected 7 drop warnings, got: ${lines.join(" | ")}`);
  for (const i of [1, 2, 3, 4, 6, 7, 8]) {
    assert.ok(lines.some((l) => l.includes(`index ${i}`)), `no warning naming index ${i}`);
  }
});

test("corrupt whole file recovers to [] (logged, idempotent, file untouched), save self-heals", async (t) => {
  const dir = await tmp("corrupt");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  const junk = '{"not":["an","array"; broken';
  await writeFile(runsFile, junk, "utf8");
  const spy = t.mock.method(console, "error");
  const store = new RunStore({ runsFile });
  assert.deepEqual(await store.load(), []);
  assert.deepEqual(await store.load(), []); // rerun idempotent
  assert.equal(spy.mock.calls.length, 2, "one warning per load, no state change");
  assert.equal(await readFile(runsFile, "utf8"), junk); // load never mutates the file
  const good = rec("healed", "2026-08-01T00:00:00.000Z");
  await store.save([good]);
  assert.deepEqual(await new RunStore({ runsFile }).load(), [good]);
});

test("atomic writes: concurrent appendOrUpdate on one store -> both records, parseable, no tmp residue", async (t) => {
  const dir = await tmp("atomic");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  const store = new RunStore({ runsFile });
  await Promise.all([
    store.appendOrUpdate(rec("c-1", "2026-08-01T00:00:00.000Z")),
    store.appendOrUpdate(rec("c-2", "2026-08-02T00:00:00.000Z")),
    store.appendOrUpdate(rec("c-3", "2026-08-03T00:00:00.000Z")),
  ]);
  const raw = await readFile(runsFile, "utf8");
  assert.deepEqual(JSON.parse(raw).map((r: { runId: string }) => r.runId), ["c-1", "c-2", "c-3"]);
  const loaded = await new RunStore({ runsFile }).load(); // fresh instance = byte truth
  assert.equal(loaded.length, 3);
  const residue = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("createRun: unique id, space dir on disk, running status, persisted via fresh store", async (t) => {
  const dir = await tmp("create");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  const store = new RunStore({ runsFile, spaceRoot: join(dir, "spaces") });
  const first = await store.createRun({ kind: "swarm", artifact: "/a/b.md", goal: "refine" });
  const second = await store.createRun({ kind: "consult", artifact: "/c/d.md" });
  assert.notEqual(first.record.runId, second.record.runId);
  assert.match(first.record.runId, /^sibyl-\d{8}T\d{6}Z-[0-9a-f]{4}$/u);
  assert.equal(first.record.status, "running");
  assert.equal(first.spaceDir, join(dir, "spaces", first.record.runId));
  assert.ok((await stat(first.spaceDir)).isDirectory());
  assert.ok((await stat(second.spaceDir)).isDirectory());
  assert.equal(first.record.goal, "refine");
  assert.equal(second.record.goal, undefined);
  // per-call spaceRootDir override wins over the store's spaceRoot
  const overridden = await store.createRun({ kind: "consult", artifact: "/e", spaceRootDir: join(dir, "alt") });
  assert.equal(overridden.spaceDir, join(dir, "alt", overridden.record.runId));
  assert.ok((await stat(overridden.spaceDir)).isDirectory());
  const fresh = new RunStore({ runsFile });
  assert.deepEqual(await fresh.getRun(first.record.runId), first.record);
  assert.equal((await fresh.load()).length, 3);
  assert.equal(await fresh.getRun("nope"), undefined);
});

// Delta invariant (rewritten from learning #4's original global-absence
// assertion): asserting "~/.sibyl does not exist" made the suite
// machine-state-dependent — any legitimate live E2E run (plan tasks 10/11)
// creates <DEFAULT_SPACE_ROOT>/<runId>/ and would permanently break the
// suite afterwards. What we actually guarantee is that the TEST ITSELF
// creates no NEW residue under the default space root: snapshot the listing
// before the store-touching operations, re-read after, assert zero new
// entries (a pre-existing tree from real runs is tolerated; absence-to-
// empty/absent is tolerated; absence-to-populated is a failure).
test("learning #4: default paths with NO env seam; real write to SIBYL/.state/sibyl restored byte-exactly; createRun isolates via explicit spaceRoot — default space root gains NO new entries", async () => {
  const savedEnv = process.env[SIBYL_STATE_FILE_ENV];
  delete process.env[SIBYL_STATE_FILE_ENV];
  const defaultFile = join(SIBYL, ".state", "sibyl", "runs.json");
  const defaultSpaceRoot = join(homedir(), ".sibyl", "spaces");
  // null = root absent; a live E2E dir appearing mid-test must not fake a
  // failure verdict about OUR residue, so absence is modeled explicitly.
  const listSpaceRoot = async (): Promise<string[] | null> =>
    readdir(defaultSpaceRoot).catch(() => null);
  let prior: Buffer | null = null;
  let wroteToDefault = false;
  try {
    assert.equal(PACKAGE_ROOT, SIBYL);
    assert.equal(DEFAULT_RUNS_FILE, defaultFile);
    assert.equal(DEFAULT_SPACE_ROOT, defaultSpaceRoot);
    const probed = new RunStore();
    assert.equal(probed.runsFile, defaultFile); // resolved path string, no env
    assert.equal(probed.spaceRoot, defaultSpaceRoot);
    const spaceBefore = await listSpaceRoot();

    // real write against the TRUE default store (runs.json only; the record's
    // spaceDir is a nominal string — appendOrUpdate never touches spaceRoot)
    prior = await readFile(defaultFile).catch(() => null);
    const priorSha = prior === null ? "ABSENT" : sha256(prior);
    const throwaway = { ...rec("sibyl-t5-default-path-probe", "2026-09-02T00:00:00.000Z", "done"), notes: "throwaway" };
    await new RunStore().appendOrUpdate(throwaway);
    wroteToDefault = true;
    const onDisk = await new RunStore().load(); // fresh instance reads the real file
    assert.ok(onDisk.some((r) => r.runId === throwaway.runId));
    // restore prior bytes exactly
    if (prior === null) await rm(defaultFile, { force: true });
    else await writeFile(defaultFile, prior);
    const restored = await readFile(defaultFile).catch(() => null);
    const afterSha = restored === null ? "ABSENT" : sha256(restored);
    console.log(`[t5-default-path] file=${defaultFile} priorSha=${priorSha} afterSha=${afterSha}`);
    assert.equal(afterSha, priorSha);

    // createRun DOES mkdir under its spaceRoot — pin that an explicit tmp
    // spaceRoot keeps every byte of the residue inside the sandbox.
    const dir = await tmp("learning4");
    try {
      const isolated = new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: dir });
      const created = await isolated.createRun({ kind: "consult", artifact: "/isolated.md" });
      assert.ok((await stat(created.spaceDir)).isDirectory());
      assert.ok(created.spaceDir.startsWith(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const spaceAfter = await listSpaceRoot();
    if (spaceBefore === null) {
      assert.ok(
        spaceAfter === null || spaceAfter.length === 0,
        `test run must create no residue under ${defaultSpaceRoot}; found [${(spaceAfter ?? []).join(", ")}]`,
      );
    } else {
      const added = (spaceAfter ?? []).filter((n) => !spaceBefore.includes(n));
      assert.deepEqual(added, [], `test run must create no new entries under ${defaultSpaceRoot}`);
    }
  } finally {
    if (wroteToDefault) {
      if (prior === null) await rm(defaultFile, { force: true }).catch(() => undefined);
      else await writeFile(defaultFile, prior).catch(() => undefined);
    }
    if (savedEnv === undefined) delete process.env[SIBYL_STATE_FILE_ENV];
    else process.env[SIBYL_STATE_FILE_ENV] = savedEnv;
  }
});

test("SIBYL_STATE_FILE seam only applies when set (explicit opts still win)", async (t) => {
  const dir = await tmp("seam");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const savedEnv = process.env[SIBYL_STATE_FILE_ENV];
  const envFile = join(dir, "env-runs.json");
  const optFile = join(dir, "opt-runs.json");
  process.env[SIBYL_STATE_FILE_ENV] = envFile;
  try {
    assert.equal(new RunStore().runsFile, envFile);
    assert.equal(new RunStore({ runsFile: optFile }).runsFile, optFile);
  } finally {
    if (savedEnv === undefined) delete process.env[SIBYL_STATE_FILE_ENV];
    else process.env[SIBYL_STATE_FILE_ENV] = savedEnv;
  }
});

// Windows libuv fallback (portability fix C): rename over an EXISTING
// destination maps to MoveFileExW(MOVEFILE_REPLACE_EXISTING), which can fail
// transiently with EPERM/EBUSY when the destination is held by a concurrent
// reader or an AV scan. save() must unlink the destination and retry the
// rename EXACTLY once; a second failure keeps the original tmp-cleanup +
// rethrow semantics.
test("save: EPERM on rename over existing target -> unlink + single retry succeeds, record persists", async (t) => {
  const dir = await tmp("rename-eperm");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  const store = new RunStore({ runsFile });
  await store.save([rec("r-before", "2026-08-01T00:00:00.000Z")]); // target exists on disk
  let calls = 0;
  const flaky: RunStore["renameFile"] = async (from, to) => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    await rename(from, to);
  };
  await store.save([rec("r-after", "2026-08-02T00:00:00.000Z")], { rename: flaky });
  assert.equal(calls, 2, "expected exactly one retry after the transient EPERM");
  const loaded = await new RunStore({ runsFile }).load(); // fresh instance = byte truth
  assert.deepEqual(loaded.map((r) => r.runId), ["r-after"]);
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), [], "no tmp residue");
});

test("save: rename failing EBUSY twice -> rethrows and leaves no tmp residue", async (t) => {
  const dir = await tmp("rename-ebusy");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsFile = join(dir, "runs.json");
  let calls = 0;
  const busy: RunStore["renameFile"] = async () => {
    calls += 1;
    throw Object.assign(new Error("device or resource busy"), { code: "EBUSY" });
  };
  const store = new RunStore({ runsFile });
  await assert.rejects(
    () => store.save([rec("r-busy", "2026-08-01T00:00:00.000Z")], { rename: busy }),
    { code: "EBUSY" },
  );
  assert.equal(calls, 2, "retry is capped at one");
  assert.equal(await stat(runsFile).then(() => false, () => true), true, "target not created");
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), [], "no tmp residue");
});
