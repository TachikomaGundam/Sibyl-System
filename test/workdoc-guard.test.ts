// workdoc-guard: R0 denylist locks (internal work-docs never on the public repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardHits } from "../scripts/workdoc-guard.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("guardHits: the three leaked classes refuse — wound doc, handoff doc, spike scratch", () => {
  const hits = guardHits(["docs/wound-chamber-dead-without-record-20261104.md", "docs/HANDOFF-2026-11-08.md", "spike/evidence/parallel-run-full.log"]);
  // Counts may exceed 3 when a file matches two classes (the .log rule and the
  // spike-evidence rule both fire); what is locked is that each named class refuses.
  for (const why of ["internal wound ledger (R0)", "internal handoff ledger (R0)", "spike evidence logs — machine paths leak (R0)"]) {
    assert.ok(hits.some((h) => h.includes(why)), `expected refusal reason: ${why}`);
  }
});

test("guardHits: scratch/cache/editor-junk classes refuse (owner hygiene directive 2026-11-12)", () => {
  const junk = [
    "notes.log", "src/util.ts.bak", "a.orig", "a.rej", "a.swp", "a.tmp",
    "scratch.ipynb", ".pytest_cache/v/cache/lastfailed", "scripts/__pycache__/x.cpython-312.pyc",
    ".DS_Store", ".vscode/settings.json", ".idea/workspace.xml",
  ];
  for (const f of junk) {
    assert.ok(guardHits([f]).length > 0, `expected refusal for ${f}`);
  }
});

test("guardHits: product surfaces pass — release records, README, src, test, spike design notes", () => {
  assert.deepEqual(guardHits(["docs/release/v1.6.5.md", "docs/democratic-centralism.md", "src/cli.ts", "test/lane-isolated.test.ts", "README.md", "spike/GO.md", "spike/scripts/register.mjs"]), []);
});

test("live repo is clean: the guard passes on this checkout (retro-cleanup 2026-11-09 holds)", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "scripts/workdoc-guard.mjs"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
});

test("refusal end-to-end: a temp repo tracking docs/wound-* exits 1 with the named reason", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-workdoc-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "wound-sample-20261109.md"), "# leak class\n", "utf8");
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  const r = spawnSync(process.execPath, ["--no-warnings", join(ROOT, "scripts", "workdoc-guard.mjs")], { encoding: "utf8", cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/wound-sample.*internal wound ledger/);
});
