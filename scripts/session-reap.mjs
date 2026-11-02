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
//    engine's own HTTP API on an ephemeral serve that this process spawns and
//    always kills — the engine owns cascade correctness;
//  - every decision (delete/keep/skip + reason) lands in a JSONL manifest;
//  - tier B (sealed audit roots) refuses to run without --owner-ruling: the
//    retention-law change is the owner's call, not the tool's;
//  - every network call carries a hard timeout — half-dead sockets hang nothing.
//
// Usage: node scripts/session-reap.mjs [--apply] [--tier-a-days=7]
//        [--port=4096] [--db=<path>] [--manifest-dir=<path>]
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

/** Full-store READ-ONLY enumeration (see header law). */
export function enumerate(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, title, parent_id AS parentID, time_created AS created, time_updated AS updated FROM session")
      .all()
      .map((r) => ({ id: r.id, title: r.title ?? "", parentID: r.parentID ?? null, created: r.created ?? 0, updated: r.updated ?? 0 }));
  } finally {
    db.close();
  }
}

const timeoutFetch = (url, opts = {}, ms = 10_000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

async function main() {
  const port = Number(args.port ?? 4096);
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
  if (!args.apply) { console.log("DRY-RUN (no deletion, no server spawned). Add --apply to execute."); return; }
  if (args["tier-b-days"] !== undefined && !args["owner-ruling"]) throw new Error("tier B requested without --owner-ruling: retention law change is the owner's call");

  const base = `http://127.0.0.1:${port}`;
  const serve = spawn(bin, ["serve", "--port", String(port)], { stdio: "ignore" });
  const kill = () => { try { serve.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", kill);
  try {
    let up = false;
    for (let i = 0; i < 20; i += 1) {
      try { if ((await timeoutFetch(`${base}/session`, {}, 2_000)).ok) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error(`serve on :${port} never answered — refusing to delete anything`);
    let ok = 0; let failed = 0;
    for (const a of del) {
      try {
        const r = await timeoutFetch(`${base}/session/${a.id}`, { method: "DELETE" }, 30_000);
        if (r.ok) ok += 1; else { failed += 1; log({ id: a.id, action: "delete-failed", http: r.status }); }
      } catch (e) { failed += 1; log({ id: a.id, action: "delete-failed", error: String(e).slice(0, 120) }); }
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = enumerate(dbPath);
    console.log(`reaped ok=${ok} failed=${failed}; session rows after=${after.length}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    kill();
  }
}

if (process.argv[1] && process.argv[1].endsWith("session-reap.mjs")) {
  main().catch((e) => { console.error(`reap refused: ${e.message}`); process.exit(1); });
}
