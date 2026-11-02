import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePaperwork, run } from "../scripts/tag-paperwork.mjs";

test("happy path: tag parity + receipt with gate: PASS", () => {
  const r = evaluatePaperwork({
    tagName: "v1.6.1", pkgVersion: "1.6.1",
    receiptExists: true, receiptText: "# Release\n\ngate: PASS\n",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test("ghost version refused: tag name != package.json version", () => {
  const r = evaluatePaperwork({
    tagName: "v9.9.9", pkgVersion: "1.6.1",
    receiptExists: true, receiptText: "gate: PASS\n",
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /version-parity/);
});

test("missing receipt refused", () => {
  const r = evaluatePaperwork({
    tagName: "v1.6.1", pkgVersion: "1.6.1", receiptExists: false, receiptText: null,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /receipt-missing: docs\/release\/v1\.6\.1\.md/);
});

test("receipt without a literal gate: PASS line refused (indented or prose form does not count)", () => {
  const r = evaluatePaperwork({
    tagName: "v1.6.1", pkgVersion: "1.6.1",
    receiptExists: true, receiptText: "the gate was PASS per report\n  gate: PASS indented\n",
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /receipt-no-pass/);
});

test("malformed tag ref fails closed before any file read", () => {
  const r = evaluatePaperwork({
    tagName: "refs/tags/v1.6.1", pkgVersion: "1.6.1", receiptExists: true, receiptText: "gate: PASS\n",
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /tag-ref-malformed/);
});

test("empty tag ref fails closed", () => {
  const r = evaluatePaperwork({ tagName: "", pkgVersion: "1.6.1", receiptExists: true, receiptText: "gate: PASS\n" });
  assert.equal(r.ok, false);
});

test("run() against a real temp tree: pass, missing file, and version drift", () => {
  const root = mkdtempSync(join(tmpdir(), "tagpaper-"));
  try {
    mkdirSync(join(root, "docs", "release"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.6.1" }));
    writeFileSync(join(root, "docs", "release", "v1.6.1.md"), "# x\n\ngate: PASS\n");
    assert.equal(run({ tagRef: "v1.6.1", root }).ok, true);

    rmSync(join(root, "docs", "release", "v1.6.1.md"));
    let r = run({ tagRef: "v1.6.1", root });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /receipt-missing/);

    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.6.0" }));
    writeFileSync(join(root, "docs", "release", "v1.6.1.md"), "gate: PASS\n");
    r = run({ tagRef: "v1.6.1", root });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /version-parity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run() with unreadable package.json reports parity, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "tagpaper-bad-"));
  try {
    writeFileSync(join(root, "package.json"), "{not json");
    const r = run({ tagRef: "v1.6.1", root });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /version-parity|receipt-missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
