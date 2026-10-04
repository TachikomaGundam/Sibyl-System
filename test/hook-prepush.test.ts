// provenance: W4 regression tests (handoff 2026-10-04): the fourth red was
// "receipt on disk, absent inside the tag" — the hook must read release facts
// ONLY from the pushed tag's object body (`git show <oid>:<path>`), never the
// working tree, and must pin the in-tag package.json version to the tag name
// (ghost-version class). Drills feed the pre-push ref line via STDIN directly
// (argv must never carry push-ish tokens; the tool layer rejects them).
//
// Locked behaviors:
//   1. compliant tag (receipt in object, gate: PASS, version match, lease) → 0
//   2. receipt present in WORKTREE only, absent in tag object            → 1  (the W4 red)
//   3. receipt in tag but worktree copy deleted                          → 0  (worktree never read)
//   4. in-tag package.json version ≠ tag name (ghost version)            → 1
//   5. receipt in tag without 'gate: PASS' at line start                 → 1
//   6. tag deletion (zero oid) passes with no receipt and no lease       → 0
//   7. non-release ref passes untouched                                  → 0
//   8. missing lease file                                                → 1
//   9. lease naming another version                                      → 1

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/git-hooks/pre-push", import.meta.url));
const run = promisify(execFile);

const ZERO = "0000000000000000000000000000000000000000";

function git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
  return run("git", ["-c", "user.email=seat@invalid", "-c", "user.name=seat", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd });
}

function receiptBody(ver: string, gateLine = "gate: PASS"): string {
  return `# release packet ${ver}\n\nborder ran green.\n${gateLine}\n`;
}

/** Build a temp repo whose annotated tag carries `pkgVersion` + (if
 * `receiptInTag`) the receipt; `receiptInWorktree` leaves an UNCOMMITTED
 * receipt on disk — the exact divergence W4 must refuse. */
async function makeRepo(opts: {
  tag: string;
  pkgVersion: string;
  receiptInTag: boolean;
  receiptGate?: string;
  receiptInWorktree?: boolean;
}): Promise<{ dir: string; oid: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-hook-test-"));
  await git(dir, "init", "-b", "main", "--quiet");
  await mkdir(join(dir, "docs", "release"), { recursive: true });
  await writeFile(join(dir, "package.json"), `{\n  "name": "sibyl-system",\n  "version": "${opts.pkgVersion}"\n}\n`, "utf8");
  if (opts.receiptInTag) {
    await writeFile(join(dir, "docs", "release", `${opts.tag}.md`), receiptBody(opts.tag, opts.receiptGate ?? "gate: PASS"), "utf8");
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "release commit");
  await git(dir, "tag", "-a", opts.tag, "-m", `release ${opts.tag}`);
  if (opts.receiptInWorktree && !opts.receiptInTag) {
    await writeFile(join(dir, "docs", "release", `${opts.tag}.md`), receiptBody(opts.tag), "utf8");
  }
  const { stdout } = await git(dir, "rev-parse", `refs/tags/${opts.tag}`);
  return { dir, oid: stdout.trim() };
}

async function leaseFor(dir: string, version: string): Promise<string> {
  const path = join(dir, "lease.json");
  await writeFile(path, JSON.stringify({ version }), "utf8");
  return path;
}

/** Feed one pre-push ref line on STDIN (the real hook protocol). */
function drive(repoDir: string, line: string, lease: string | null): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.SIBYL_RELEASE_LEASE = lease ?? join(repoDir, "no-such-lease.json");
    const child = execFile("bash", [HOOK, "origin", "https://gate.test.invalid/repo.git"], { cwd: repoDir, env }, (err, _stdout, stderr) => {
      void err;
      resolvePromise({ code: child.exitCode ?? 1, stderr: stderr ?? "" });
    });
    child.stdin?.write(`${line}\n`);
    child.stdin?.end();
  });
}

test("W4-1 compliant tag: receipt in object + version match + lease → pass", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.stderr);
});

test("W4-2 THE RED: receipt in worktree but NOT in tag object → refuse", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false, receiptInWorktree: true });
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /NOT in the tag object/);
});

test("W4-3 worktree receipt deleted after commit: tag object still passes (worktree never read)", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  await rm(join(dir, "docs", "release", "v9.9.9.md"));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.stderr);
});

test("W4-4 ghost version: in-tag package.json 9.9.8 under tag v9.9.9 → refuse", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.8", receiptInTag: true });
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ghost-version/);
});

test("W4-5 receipt without 'gate: PASS' at line start → refuse", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true, receiptGate: "- gate: PASS" });
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /gate: PASS/);
});

test("W4-6 tag deletion passes with zero paperwork", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false });
  const res = await drive(dir, `refs/tags/v9.9.9 ${ZERO} refs/tags/v9.9.9 ${oid}`, null);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.stderr);
});

test("W4-7 non-release ref untouched", async () => {
  const { dir } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false });
  const { stdout } = await git(dir, "rev-parse", "HEAD");
  const res = await drive(dir, `refs/heads/main ${stdout.trim()} refs/heads/main ${ZERO}`, null);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.stderr);
});

test("W4-8 missing lease → refuse", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, null);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no release lease/);
});

test("W4-9 lease names another version → refuse", async () => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  const lease = await leaseFor(dir, "v8.8.8");
  const res = await drive(dir, `refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${ZERO}`, lease);
  await rm(dir, { recursive: true, force: true });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not name v9\.9\.9/);
});
