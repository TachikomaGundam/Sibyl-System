// provenance: W4 regression tests (handoff HANDOFF-SIBYL-20261004.md), hardened
// by the live council review of run sibyl-20261004T163519Z-f68c: object-vs-
// worktree divergence locked for BOTH release facts (receipt AND version),
// every stdin ref line policed, crash-vs-refusal distinguished, env sanitized,
// teardown after assertions. The hook must read release facts ONLY from the
// pushed tag's object body (`git show <oid>:<path>`), never the working tree,
// and must pin the in-tag package.json version to the tag name. Drills feed
// ref lines via STDIN (argv never carries push-ish tokens).

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

type RepoOpts = {
  tag: string;
  pkgVersion: string;
  receiptInTag: boolean;
  receiptGate?: string;
  /** leave an UNCOMMITTED receipt in the worktree (the W4 receipt-side red) */
  receiptInWorktree?: boolean;
  /** dirty the worktree package.json after commit+tag (the W4 version-side red) */
  pkgWorktreeOverride?: string;
  annotated?: boolean;
};

async function makeRepo(opts: RepoOpts): Promise<{ dir: string; oid: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-hook-test-"));
  await git(dir, "init", "-b", "main", "--quiet");
  await mkdir(join(dir, "docs", "release"), { recursive: true });
  await writeFile(join(dir, "package.json"), `{\n  "name": "sibyl-system",\n  "version": "${opts.pkgVersion}"\n}\n`, "utf8");
  if (opts.receiptInTag) {
    await writeFile(join(dir, "docs", "release", `${opts.tag}.md`), receiptBody(opts.tag, opts.receiptGate ?? "gate: PASS"), "utf8");
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "release commit");
  await git(dir, opts.annotated === false ? "tag" : "tag", ...(opts.annotated === false ? [] : ["-a"]), opts.tag, ...(opts.annotated === false ? [] : ["-m", `release ${opts.tag}`]));
  if (opts.receiptInWorktree && !opts.receiptInTag) {
    await writeFile(join(dir, "docs", "release", `${opts.tag}.md`), receiptBody(opts.tag), "utf8");
  }
  if (opts.pkgWorktreeOverride !== undefined) {
    await writeFile(join(dir, "package.json"), `{\n  "name": "sibyl-system",\n  "version": "${opts.pkgWorktreeOverride}"\n}\n`, "utf8");
  }
  const { stdout } = await git(dir, "rev-parse", `refs/tags/${opts.tag}`);
  return { dir, oid: stdout.trim() };
}

async function leaseFor(dir: string, version: string): Promise<string> {
  const path = join(dir, "lease.json");
  await writeFile(path, JSON.stringify({ version }), "utf8");
  return path;
}

/** Feed pre-push ref lines on STDIN (the real protocol). Crash and refusal are
 * distinct outcomes; inherited env is sanitized so no operator lease or
 * receipt-dir override can silently steer a drill. */
function drive(repoDir: string, lines: string[], lease: string | null): Promise<{ code: number; crashed: boolean; stderr: string }> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: repoDir };
    delete env["SIBYL_RELEASE_RECEIPT_DIR"];
    env["SIBYL_RELEASE_LEASE"] = lease ?? join(repoDir, "no-such-lease.json");
    const child = execFile("bash", [HOOK, "origin", "https://gate.test.invalid/repo.git"], { cwd: repoDir, env }, (err, _stdout, stderr) => {
      void err;
      const crashed = child.signalCode !== null || child.exitCode === null;
      resolvePromise({ code: crashed ? -1 : (child.exitCode as number), crashed, stderr: stderr ?? "" });
    });
    child.stdin?.on("error", () => undefined); // a fast-exiting hook must not EPIPE-crash the runner
    for (const line of lines) child.stdin?.write(`${line}\n`);
    child.stdin?.end();
  });
}

const pushLine = (ref: string, oid: string) => `refs/tags/${ref} ${oid} refs/tags/${ref} ${ZERO}`;

test("W4-1 compliant tag: receipt in object + version match + lease → pass", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-2 THE RED (receipt side): worktree-only receipt, absent in tag object → refuse", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false, receiptInWorktree: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /NOT in the tag object/);
});

test("W4-3 worktree receipt deleted after commit: tag object still passes (worktree never read)", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  await rm(join(dir, "docs", "release", "v9.9.9.md"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-4 ghost version: in-tag package.json 9.9.8 under tag v9.9.9 → refuse", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.8", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ghost-version/);
});

test("W4-5 receipt without exact 'gate: PASS' → refuse; PASSED prefix and FAIL also refuse", async () => {
  for (const gate of ["- gate: PASS", "gate: PASSED", "gate: FAIL", "gate: pass"]) {
    const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true, receiptGate: gate });
    const lease = await leaseFor(dir, "v9.9.9");
    const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
    await rm(dir, { recursive: true, force: true });
    assert.equal(res.code, 1, `gate line "${gate}" must not pass`);
    assert.match(res.stderr, /gate: PASS/);
  }
});

test("W4-6 tag deletion passes with zero paperwork", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const res = await drive(dir, [`refs/tags/v9.9.9 ${ZERO} refs/tags/v9.9.9 ${oid}`], null);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-7 non-release ref untouched", async (t) => {
  const { dir } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await git(dir, "rev-parse", "HEAD");
  const res = await drive(dir, [`refs/heads/main ${stdout.trim()} refs/heads/main ${ZERO}`], null);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-8 missing lease → refuse", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const res = await drive(dir, [pushLine("v9.9.9", oid)], null);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no release lease/);
});

test("W4-9 lease names another version → refuse", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v8.8.8");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not name v9\.9\.9/);
});

test("W4-10 THE RED (version side): in-tag 9.9.8 + worktree dirtied to 9.9.9 → refuse (object read, not tree)", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.8", receiptInTag: true, pkgWorktreeOverride: "9.9.9" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ghost-version/);
});

test("W4-10b inverse: in-tag 9.9.9 + worktree dirtied to 9.9.8 → still pass (tree never consulted)", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true, pkgWorktreeOverride: "9.9.8" });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-11 pushed oid is the authority: second non-compliant tag object pushed by oid while a compliant ref exists → refuse", async (t) => {
  const { dir } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  // build a SECOND, receipt-less tag object for the same name lineage: commit a
  // version bump without a receipt and tag it under a different name
  await writeFile(join(dir, "package.json"), `{\n  "name": "sibyl-system",\n  "version": "9.9.8"\n}\n`, "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "--quiet", "-m", "ghost candidate");
  await git(dir, "tag", "-a", "v8.8.8", "-m", "no receipt here");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await git(dir, "rev-parse", "refs/tags/v8.8.8");
  const lease = await leaseFor(dir, "v8.8.8");
  const res = await drive(dir, [pushLine("v8.8.8", stdout.trim())], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /NOT in the tag object/);
});

test("W4-12 every stdin line is policed: compliant line + violating line (both orders) → refuse naming the violation", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  await git(dir, "commit", "--quiet", "--allow-empty", "-m", "head for second tag");
  await git(dir, "tag", "-a", "v8.8.8", "-m", "receipt-less tag");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await git(dir, "rev-parse", "refs/tags/v8.8.8");
  const badOid = stdout.trim();
  const lease = await leaseFor(dir, "v9.9.9");
  for (const lines of [[pushLine("v9.9.9", oid), pushLine("v8.8.8", badOid)], [pushLine("v8.8.8", badOid), pushLine("v9.9.9", oid)]]) {
    const res = await drive(dir, lines, lease);
    assert.equal(res.code, 1, lines.join(" | "));
    assert.match(res.stderr, /v8\.8\.8/);
  }
});

test("W4-14 update push of an existing tag (nonzero remote oid) is policed", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.8", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [`refs/tags/v9.9.9 ${oid} refs/tags/v9.9.9 ${"1".repeat(40)}`], lease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ghost-version/);
});

test("W4-15 lightweight tag (commit oid, no tag object) reads its body the same way", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true, annotated: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await leaseFor(dir, "v9.9.9");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], lease);
  assert.equal(res.crashed, false, res.stderr);
  assert.equal(res.code, 0, res.stderr);
});

test("W4-16 malformed lease JSON → refuse (never laundering a broken lease)", async (t) => {
  const { dir, oid } = await makeRepo({ tag: "v9.9.9", pkgVersion: "9.9.9", receiptInTag: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const badLease = join(dir, "bad-lease.json");
  await writeFile(badLease, "{not json", "utf8");
  const res = await drive(dir, [pushLine("v9.9.9", oid)], badLease);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not name v9\.9\.9/);
});
