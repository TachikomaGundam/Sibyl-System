// provenance: v1.4.0 private-directory law tests (owner-approved release round;
// third-party audit MEDIUM finding: run dirs under world-writable /tmp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirPrivate } from "../src/fsperm.ts";

// The law: st_mode & 0o077 === 0 for every plugin-created directory, independent
// of umask and of any pre-existing leaf mode.

test("mkdirPrivate: new leaf is private under default umask", async () => {
  const root = await mkdtemp(join(tmpdir(), "sibyl-fsperm-"));
  try {
    const dir = join(root, "sibyl-run-x");
    await mkdirPrivate(dir);
    assert.equal(statSync(dir).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mkdirPrivate: world-readable pre-existing leaf is re-closed (chmod, not mkdir-only)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sibyl-fsperm-"));
  try {
    const dir = join(root, "sibyl-run-y");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755); // a leftover from a pre-1.4.0 run: readable to other accounts
    assert.notEqual(statSync(dir).mode & 0o077, 0);
    await mkdirPrivate(dir);
    assert.equal(statSync(dir).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mkdirPrivate: deep creation under the temp root stays private", async () => {
  const root = await mkdtemp(join(tmpdir(), "sibyl-fsperm-"));
  try {
    const deep = join(root, "spaces", "sibyl-run-z", "voice");
    await mkdirPrivate(deep);
    assert.equal(statSync(deep).mode & 0o077, 0);
    assert.equal(statSync(join(root, "spaces")).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
