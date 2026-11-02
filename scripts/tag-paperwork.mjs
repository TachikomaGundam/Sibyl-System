#!/usr/bin/env node
// Server-side tag paperwork (the W4 checks re-run where bypass cannot reach).
// The local pre-push hook (rule W4) checks these same facts but is skippable
// (`--no-verify`, fresh clones). This script is the non-skippable echo:
//   1. tag name equals "v" + package.json version (ghost-version guard);
//   2. the release record docs/release/<version>.md exists in the tagged
//      tree and carries the literal line `gate: PASS` (receipt law).
// Env: TAG_REF (the tag being published, e.g. v1.6.1), CWD defaults to repo root.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function evaluatePaperwork({ tagName, pkgVersion, receiptExists, receiptText }) {
  const problems = [];
  if (typeof tagName !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) {
    problems.push(`tag-ref-malformed: "${tagName}" is not v<semver>`);
    return { ok: false, problems };
  }
  const version = tagName.slice(1);
  if (pkgVersion !== version) {
    problems.push(`version-parity: tag says ${version}, package.json says ${pkgVersion}`);
  }
  if (!receiptExists) {
    problems.push(`receipt-missing: docs/release/${tagName}.md absent from the tagged tree`);
  } else if (!/^gate: PASS$/m.test(String(receiptText))) {
    problems.push(`receipt-no-pass: docs/release/${tagName}.md lacks a literal "gate: PASS" line`);
  }
  return { ok: problems.length === 0, problems };
}

export function run({ tagRef, root = process.cwd() }) {
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null;
  } catch { /* reported as parity problem below via null */ }
  // Release records are named after the TAG (docs/release/v1.6.1.md), matching
  // the pre-push hook and docs/release/ contents on disk.
  const receiptName = typeof tagRef === "string" && /^v\d/.test(tagRef) ? tagRef : null;
  const receiptPath = receiptName ? join(root, "docs", "release", `${receiptName}.md`) : null;
  const receiptExists = receiptPath !== null && existsSync(receiptPath);
  let receiptText = null;
  if (receiptExists) {
    try { receiptText = readFileSync(receiptPath, "utf8"); } catch { receiptText = ""; }
  }
  return evaluatePaperwork({ tagName: tagRef, pkgVersion, receiptExists, receiptText });
}

if (process.argv[1] && process.argv[1].endsWith("tag-paperwork.mjs")) {
  const tagRef = process.env.TAG_REF ?? "";
  const res = run({ tagRef });
  if (!res.ok) {
    for (const p of res.problems) console.error(`tag-paperwork: ${p}`);
    process.exit(1);
  }
  console.log(`tag-paperwork: PASS — ${tagRef} parity + receipt verified`);
}
