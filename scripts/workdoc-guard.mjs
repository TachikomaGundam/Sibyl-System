#!/usr/bin/env node
// workdoc-guard: the R0 law made mechanical — internal work-doc classes
// (wound ledgers, handoff ledgers, spike scratch) must never be tracked on
// the public product repo. Retroactive cleanup 2026-11-09 removed the
// pre-R0 entries (2 wound docs + 7 spike logs, one carrying the operator's
// email address into the public history); this gate is the never-again door.
// Usage: node scripts/workdoc-guard.mjs   (reads `git ls-files`; exit 1 = denylist hit)

const DENY = [
  { pat: /^docs\/wound-/, why: "internal wound ledger (R0)" },
  { pat: /^docs\/HANDOFF-/, why: "internal handoff ledger (R0)" },
  { pat: /^spike\/evidence\//, why: "spike evidence logs — machine paths leak (R0)" },
];

export function guardHits(files) {
  return files.flatMap((f) => DENY.filter((d) => d.pat.test(f)).map((d) => `${f}: ${d.why}`));
}

const main = process.argv[1] !== undefined && process.argv[1].endsWith("workdoc-guard.mjs");
if (main) {
  const { execFileSync } = await import("node:child_process");
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((s) => s.length > 0);
  const hits = guardHits(files);
  if (hits.length > 0) {
    console.error(`workdoc-guard REFUSED: internal work-doc tracked in the public repo (R0: ledgers live OUTSIDE the product repo)\n${hits.map((h) => `  ${h}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`workdoc-guard: ${String(files.length)} tracked files, zero work-doc-class hits`);
}
