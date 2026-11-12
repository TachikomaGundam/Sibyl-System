#!/usr/bin/env node
// session-reap: bounded retention for the Sibyl lane's engine sessions.
//
// Why this exists (2026-11 measurement): L1 GC only reclaims HEADLESS children
// on success; PARENTED voter/worker children (sibyl:persona …) were kept by law
// forever and accumulated to 1573 rows. Audit conveners (sibyl:audit *) are
// deliberately retained — receipt law — and are NEVER touched unless the owner
// explicitly authorizes tier B in the same invocation.
//
// Law:
//  - dry-run by default; deletion requires --apply;
//  - ENUMERATION is read-only SQLite (the HTTP list is instance-scoped and
//    cannot see cross-project accumulation); DELETION goes ONLY through the
//    engine's own CLI (`opencode session delete <id>`, which owns cascade
//    correctness over messages/children) — never through raw sqlite writes;
//  - every decision (delete/keep/skip + reason) lands in a JSONL manifest;
//  - tier B (sealed audit roots) refuses to run without --owner-ruling: the
//    retention-law change is the owner's call, not the tool's;
//  - every delete is one spawned CLI call with a hard timeout — half-dead
//    child processes are killed, never awaited forever.
//
// opencode 2.x migration (2026-11-12): the V1-era serve + `DELETE /session/:id`
// channel is dead on 2.x (route answers 405), and live sessions now land in
// the `session_v2` table (the old `session` table is legacy debris from the
// 1.x engine and no longer receives writes — verified against 2.2.7: plugin
// smoke sessions appear in session_v2 only). Enumeration and deletion both
// moved accordingly; legacy-table cleanup is deliberately OUT of scope here.
//
// Usage: node scripts/session-reap.mjs [--apply] [--tier-a-days=7]
//        [--db=<path>] [--manifest-dir=<path>]
//        [--tier-b-days=N --owner-ruling] [--keep=<regex>]

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400_000;

/** Pure classifier — unit-tested in test/session-reap.test.ts.
 * scope is deliberately narrow: ONLY titles the Sibyl product itself mints
 * ('sibyl:' prefix) are candidates; everything else is out of scope. */
export function classify(sessions, opts) {
  const { nowMs, tierADays, tierBDays = null, ownerRuling = false, keepRe = null } = opts;
  const actions = [];
  for (const s of sessions) {
    const title = s.title ?? "";
    const id = s.id ?? "";
    const ageDays = (nowMs - (s.updated ?? 0)) / DAY;
    const keep = (action, reason) => actions.push({ id, title, action, reason, ageDays: Math.floor(ageDays), created: s.created ?? 0, parentNull: !s.parentID });
    if (!title.toLowerCase().startsWith("sibyl:")) continue; // out of scope, not listed
    if (keepRe && keepRe.test(id)) { keep("keep", "--keep override"); continue; }
    if (title.toLowerCase().startsWith("sibyl:audit")) {
      if (tierBDays !== null && ownerRuling && ageDays > tierBDays) { keep("delete", `tier-B audit root > ${tierBDays}d (owner-ruling)`); continue; }
      keep("keep", "audit-convener retained by receipt law (tier B needs --owner-ruling)");
      continue;
    }
    if (s.parentID) {
      if (ageDays > tierADays) { keep("delete", `tier-A parented persona child > ${tierADays}d`); continue; }
      keep("keep", `tier-A grace: age <= ${tierADays}d`);
      continue;
    }
    keep("keep", "root persona/out-of-family: not reaped by this tool");
  }
  return actions;
}

/** Live-store READ-ONLY enumeration (see header law). 2.x stores sessions in
 * session_v2; the 1.x `session` table is legacy and NOT reaped (see header). */
export function enumerate(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, title, parent_id AS parentID, time_created AS created, time_updated AS updated FROM session_v2")
      .all()
      .map((r) => ({ id: r.id, title: r.title ?? "", parentID: r.parentID ?? null, created: r.created ?? 0, updated: r.updated ?? 0 }));
  } finally {
    db.close();
  }
}

/** One engine-owned deletion: `opencode session delete <id>` with a hard kill
 * timer (cross-project verified on 2.2.7: the CLI resolves the id through the
 * engine store, not the cwd's project). Resolves true on exit code 0. */
export function deleteSession(bin, id, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const child = spawn(bin, ["session", "delete", id], { stdio: "ignore" });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(false);
    }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); done(false); });
    child.on("exit", (code) => { clearTimeout(timer); done(code === 0); });
  });
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

async function main() {
  const bin = process.env["OPENCODE_BIN"] ?? join(homedir(), ".local", "bin", "opencode");
  const dbPath = args.db ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
  const manifestDir = args["manifest-dir"] ?? join(homedir(), "workspace", "harness", "Sibyl", ".omo", "evidence", `reap-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(manifestDir, { recursive: true });
  const manifest = join(manifestDir, "manifest.jsonl");
  const log = (o) => appendFileSync(manifest, JSON.stringify(o) + "\n");

  const sessions = enumerate(dbPath);
  const actions = classify(sessions, {
    nowMs: Date.now(),
    tierADays: Number(args["tier-a-days"] ?? 7),
    tierBDays: args["tier-b-days"] !== undefined ? Number(args["tier-b-days"]) : null,
    ownerRuling: Boolean(args["owner-ruling"]),
    keepRe: args.keep ? new RegExp(String(args.keep)) : null,
  });
  const del = actions.filter((a) => a.action === "delete");
  for (const a of actions) log(a);
  console.log(`candidates: delete=${del.length} keep=${actions.length - del.length} (manifest=${manifest})`);
  if (!args.apply) { console.log("DRY-RUN (no deletion). Add --apply to execute."); return; }
  if (args["tier-b-days"] !== undefined && !args["owner-ruling"]) throw new Error("tier B requested without --owner-ruling: retention law change is the owner's call");

  let ok = 0;
  let failed = 0;
  for (const a of del) {
    if (await deleteSession(bin, a.id)) ok += 1;
    else { failed += 1; log({ id: a.id, action: "delete-failed", channel: "opencode session delete" }); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const after = enumerate(dbPath);
  console.log(`reaped ok=${ok} failed=${failed}; session_v2 rows after=${after.length}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("session-reap.mjs")) {
  main().catch((e) => { console.error(`reap refused: ${e.message}`); process.exit(1); });
}
