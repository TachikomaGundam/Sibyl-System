#!/usr/bin/env node
// provenance: W1 handoff law — "既往自召票一次性回填标记" (one-time backfill of
// prior self-convened ballots), HANDOFF-SIBYL-20261004.md.
//
// Discipline honored while doing it:
//   - engine-store forensics, not narrative: the 91fc chain/kinship finding is
//     re-derived live from opencode.db (parent links + completed write parts
//     targeting the reviewed artifact); if the forensics do not reproduce, the
//     script refuses (exit 2) rather than mark from the story;
//   - single-writer: refuses while a FRESH running row exists (updated inside
//     the live window). Old frozen-at-running rows are the documented honest
//     face of interrupted runs (t11 lesson) — they are listed, never rewritten;
//   - atomic write (tmp + rename, same mount), pre-image .bak beside the file,
//     read-back verification BEFORE the caller may remove the .bak;
//   - every untouched-on-disk fact preserved: this adds ONE field per record
//     and rewrites nothing else.
//
// Usage: node --import ./tools/register-ts.mjs scripts/backfill-independence.mjs [--runs <path>] [--dry]

import { execFileSync } from "node:child_process";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { validateEntry } from "../src/state/record.ts";

const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  return i > -1 ? process.argv[i + 1] : join(homedir(), ".sibyl", "runs.json");
})();
const DRY = process.argv.includes("--dry");
const DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const SELF_CONVOKED = "sibyl-20261004T103040Z-91fc";
const CHARTER_FILE = "charter-amendment-20261004.md";

function q(sql) {
  return execFileSync("sqlite3", ["-readonly", DB, sql], { encoding: "utf8" }).trim();
}

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(msg) {
  console.error(`backfill: ${msg}`);
  process.exit(2);
}

const raw = await readFile(RUNS, "utf8").catch(() => fail(`runs file unreadable: ${RUNS}`));
const preHash = sha(Buffer.from(raw, "utf8"));
const runs = JSON.parse(raw);
if (!Array.isArray(runs)) fail("runs root is not an array");
// a live engine never leaves a row untouched for 30 min mid-run (budget:
// timeoutMs + salvage + retries are all far below this); older frozen rows
// are interrupted runs, not writers.
const LIVE_WINDOW_MS = 30 * 60 * 1000;
const nowMs = Date.now();
const fresh = runs.filter((r) => r.status === "running" && nowMs - Date.parse(r.updatedAt) < LIVE_WINDOW_MS);
if (fresh.length > 0) fail(`${String(fresh.length)} run(s) LIVE within the 30-min window: single-writer law — retry after they land`);
const stale = runs.filter((r) => r.status === "running");
if (stale.length > 0) console.log(`note: ${String(stale.length)} frozen-at-running rows (interrupted runs, honest face kept): ${stale.map((r) => r.runId).join(", ")}`);

// --- forensics for the known self-convened run (engine DB is the witness) ---
const space = runs.find((r) => r.runId === SELF_CONVOKED)?.spaceDir;
if (space === undefined) fail(`run ${SELF_CONVOKED} not present in ${RUNS}`);
const reply = await readFile(join(space, "MELCHIOR.md"), "utf8").catch(() => fail("voter reply file unreadable — cannot re-derive chain"));
const voterIds = [...new Set([...reply.matchAll(/session (ses_[A-Za-z0-9]+)/g)].map((m) => m[1]))];
if (voterIds.length === 0) fail("no voter session id in the reply face — cannot re-derive chain");
const inList = voterIds.map((id) => `'${id}'`).join(",");
const parents = [...new Set(q(`SELECT parent_id FROM session WHERE id IN (${inList}) AND parent_id IS NOT NULL AND parent_id <> '';`).split("\n").filter(Boolean))];
if (parents.length !== 1) fail(`voter sessions resolve to ${String(parents.length)} distinct parents — ambiguous convener, refusing`);
const convener = parents[0];
const nWrites = Number(q(`SELECT count(*) FROM part WHERE session_id='${convener}' AND data LIKE '%${CHARTER_FILE}%' AND data LIKE '%"tool":"write"%' AND data LIKE '%"status":"completed"%'`));
if (nWrites < 1) fail(`convener ${convener} shows no completed write of ${CHARTER_FILE} — kinship NOT reproduced, refusing to mark from narrative`);
const chainTitle = q(`SELECT title FROM session WHERE id='${convener}'`).replace(/\s+/g, " ");

const backfillEvidence =
  `backfill 2026-10-05 (W1, one-time): engine-store forensics re-ran clean — voter sessions parent to ${convener} ` +
  `("${chainTitle}", root); that session holds ${String(nWrites)} completed write part(s) targeting ${CHARTER_FILE}, ` +
  `the reviewed artifact; convener chain == drafting chain. Order source: debug/handoffs/sibyl-evolution-digest-20261004.md §one.3.`;

// --- apply ---
let marked = 0;
let unverifiable = 0;
for (const r of runs) {
  if (r.independence !== undefined) continue; // idempotent: already carries the leg
  if (r.runId === SELF_CONVOKED) {
    r.independence = { status: "NOT-INDEPENDENT", convenerChain: [convener], evidence: backfillEvidence };
    marked += 1;
  } else {
    r.independence = {
      status: "UNVERIFIABLE",
      convenerChain: [],
      evidence: "pre-W1 record: the convener chain was never captured at convening time; independence cannot be asserted retroactively (named backfill: only " + SELF_CONVOKED + ")",
    };
    unverifiable += 1;
  }
}

// every touched record must validate through the record layer itself
for (const r of runs) {
  const v = validateEntry(r);
  if (!v.ok) fail(`post-patch record ${r.runId} rejected by validateEntry: ${v.reason}`);
}

console.log(`runs=${String(runs.length)} marked=${String(marked)} unverifiable=${String(unverifiable)} pre_sha256=${preHash}`);
if (DRY) {
  console.log("dry run: nothing written");
  process.exit(0);
}
if (!existsSync(DB)) fail(`engine store missing at ${DB} — forensics could not have run`);

const bak = `${RUNS}.pre-backfill.bak`;
await copyFile(RUNS, bak);
const json = `${JSON.stringify(runs, null, 2)}\n`;
// tmp MUST share the target's mount (EXDEV lesson, same turn self-caught):
// atomic rename only holds inside one filesystem.
const tmp = join(dirname(RUNS), `runs.backfill.${String(process.pid)}.tmp`);
await writeFile(tmp, json, "utf8");
await rename(tmp, RUNS);
const written = await readFile(RUNS, "utf8");
if (sha(Buffer.from(written, "utf8")) !== sha(Buffer.from(json, "utf8"))) fail("read-back hash mismatch");
const reload = JSON.parse(written);
const hit = reload.find((r) => r.runId === SELF_CONVOKED);
if (hit?.independence?.status !== "NOT-INDEPENDENT") fail("read-back: self-convoked mark missing");
if (reload.length !== runs.length) fail("read-back: record count drifted");
console.log(`post_sha256=${sha(Buffer.from(written, "utf8"))} bak=${bak} (remove ONLY after inspection)`);
