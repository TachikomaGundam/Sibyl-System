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
// H2 frozen-manifest mode (2026-11-14, council
// sibyl-20261114T101952Z-d820 must_fix 4/8/12). A dry run writes a manifest;
// if the store changes between adjudication and execution, re-enumerating at
// apply time can drift the delete set (rows age in, rows disappear). --manifest
// freezes the ADJUDICATED ids instead:
//   node scripts/session-reap.mjs --manifest=<path> [--apply] [gates...]
//  - ONLY the time-based recomputation is skipped. Every other gate revalidates
//    per row against the live store and FAIL-CLOSES the batch:
//      * title must still be in the Sibyl family ('sibyl:' prefix);
//      * an audit-root row still requires --owner-ruling;
//      * --keep still wins.
//  - a manifest id already absent from the store is recorded 'absent' (idempotent
//    re-run of a partially applied sweep), not an error.
//  - manifest rows are deleted CHILD-FIRST (children resolved from the live
//    parent_id graph), so an explicit parent never precedes its children.
//  - input accepts either our own manifest rows (action:"delete") or a
//    DEAD-LETTER.jsonl row set ({sessionId,reason}) from src/tools/reclaim.ts —
//    the named crash/retry recovery path for ids that were registered but never
//    deleted (must_fix 12).
//
// Usage: node scripts/session-reap.mjs [--apply] [--tier-a-days=7]
//        [--db=<path>] [--manifest-dir=<path>] [--manifest=<path>]
//        [--tier-b-days=N --owner-ruling] [--keep=<regex>]

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

/** Frozen-manifest input (H2): accepts our own manifest rows ({action:"delete",
 * id}) and reclaim DEAD-LETTER rows ({sessionId}). Returns ordered unique
 * [{id, source}]. Throws on unparseable JSON — a corrupt ledger is refused,
 * never half-trusted. */
export function readDeleteSet(path, readText = null) {
  const text = readText ?? readFileSync(path, "utf8");
  const out = [];
  const seen = new Set();
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo += 1;
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`manifest line ${lineNo} is not valid JSON`);
    }
    const id = row && typeof row === "object"
      ? (row.action === "delete" && typeof row.id === "string" ? row.id : typeof row.sessionId === "string" ? row.sessionId : null)
      : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source: typeof row.sessionId === "string" ? "dead-letter" : "manifest" });
  }
  return out;
}

/** Child-first ordering (H2 must_fix 1 / schema fact: parent_id has no FK
 * cascade): deeper descendants sort before their in-set ancestors. Cycles (not
 * producible by the engine) degrade to input order via the depth guard. */
export function orderChildFirst(ids, parentById) {
  const set = new Set(ids);
  const depthOf = (id) => {
    let d = 0;
    let p = parentById.get(id) ?? null;
    const guard = new Set([id]);
    while (p !== null && set.has(p) && !guard.has(p) && d < 64) {
      guard.add(p);
      p = parentById.get(p) ?? null;
      d += 1;
    }
    return d;
  };
  return [...ids].sort((a, b) => depthOf(b) - depthOf(a));
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

// --dry-manifest: classify-only pass — frozen manifest + summary are written,
// NOTHING is deleted, and main() stops right after the manifest (no re-run of
// classification at a later instant). Front-end for frozen-set sweeps.
const DRY_MANIFEST = args["dry-manifest"] === true;

async function main() {
  const bin = process.env["OPENCODE_BIN"] ?? join(homedir(), ".local", "bin", "opencode");
  const dbPath = args.db ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
  const manifestDir = args["manifest-dir"] ?? join(homedir(), "workspace", "harness", "Sibyl", ".omo", "evidence", `reap-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(manifestDir, { recursive: true });
  const manifest = join(manifestDir, "manifest.jsonl");
  const log = (o) => appendFileSync(manifest, JSON.stringify(o) + "\n");
  const ownerRuling = Boolean(args["owner-ruling"]);
  const keepRe = args.keep ? new RegExp(String(args.keep)) : null;

  // ---- H2 frozen-manifest mode: the adjudicated set, not a re-computation ----
  if (args.manifest) {
    const entries = readDeleteSet(String(args.manifest));
    const now = enumerate(dbPath);
    const byId = new Map(now.map((s) => [s.id, s]));
    const parentById = new Map(now.map((s) => [s.id, s.parentID]));
    const live = [];
    let absent = 0;
    for (const e of entries) {
      const s = byId.get(e.id);
      if (s === undefined) {
        absent += 1;
        log({ id: e.id, action: "absent", reason: "not in store (idempotent re-apply)", source: e.source });
        continue;
      }
      const title = s.title ?? "";
      if (!title.toLowerCase().startsWith("sibyl:")) {
        throw new Error(`manifest gate: ${e.id} title "${title}" is outside the Sibyl family — batch refused`);
      }
      if (keepRe !== null && keepRe.test(e.id)) {
        log({ id: e.id, action: "keep", reason: "--keep override", title });
        continue;
      }
      if (title.toLowerCase().startsWith("sibyl:audit") && !ownerRuling) {
        throw new Error(`manifest gate: ${e.id} is an audit root — tier B needs --owner-ruling (owner's call)`);
      }
      live.push(e.id);
    }
    // ORPHAN GUARD (2026-11-14 backlog audit): deleting a row whose PARENT is a
    // live store row outside the delete set strands the engine-cascaded child
    // chain. Refused unless --allow-orphans names the parent's fate same-set.
    // --promote-orphans: a delete whose parent is absent is the ROOT of its
    // family; its engine cascade removes the whole subtree. Keep those, drop
    // children whose parent would remain live (the orphan-refused rule).
    if (args["promote-orphans"]) {
      const absentNow = new Set(entries.filter((e) => !live.includes(e.id)).map((e) => e.id));
      const roots = new Set(live.filter((id) => {
        const pid = parentById.get(id);
        return pid == null || !now.has(pid) || absentNow.has(pid);
      }));
      const dropped = live.filter((id) => !roots.has(id));
      for (const id of dropped) log({ id, action: "orphan-refused", parent: parentById.get(id), reason: "parent live and outside the delete set (--promote-orphans keeps cascade roots only)" });
      live.length = 0;
      live.push(...roots);
    }
    const allById = new Map(now.map((s) => [s.id, s]));
    const delSet = new Set(live);
    const allowOrphans = Boolean(args["allow-orphans"]);
    const kept = [];
    for (const id of live) {
      const pid = parentById.get(id);
      if (pid != null && allById.has(pid) && !delSet.has(pid)) {
        if (allowOrphans) kept.push(id);
        else log({ id, action: "orphan-refused", parent: pid, reason: "parent row is live and outside the delete set" });
      } else kept.push(id);
    }
    live.length = 0;
    live.push(...kept);
    const orphanRefused = entries.length - live.length - absent;
    const ordered = orderChildFirst(live, parentById);
    console.log(`manifest mode: rows=${entries.length} to-delete=${live.length} absent=${absent} orphan-refused=${orphanRefused} (receipt=${manifest})`);
    if (!args.apply) {
      console.log("DRY-RUN (no deletion). Add --apply to execute the frozen set.");
      return;
    }
    let ok = 0;
    let failed = 0;
    for (const id of ordered) {
      if (await deleteSession(bin, id)) {
        ok += 1;
        log({ id, action: "deleted", channel: "opencode session delete", order: "child-first" });
      } else {
        failed += 1;
        log({ id, action: "delete-failed", channel: "opencode session delete" });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`manifest reap ok=${ok} failed=${failed}; session_v2 rows after=${enumerate(dbPath).length}`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

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
  if (DRY_MANIFEST) {
    const parents = new Set(sessions.map((s) => s.parentID).filter(Boolean));
    const orphans = del.filter((a) => !parents.has(a.id)).map((a) => a.id);
    for (const id of orphans) log({ id, action: "orphan-refused", reason: "parent row outside the sibyl delete set — deleting would orphan it; a ruling must name the parent too" });
    console.log(`DRY-MANIFEST: delete=${del.length - orphans.length} orphans-not-deletable=${orphans.length} keep=${actions.length - del.length} (receipt=${manifest})`);
    console.log("No deletion performed. Apply with: --manifest=<receipt> [--owner-ruling] [--allow-orphans] --apply");
    return;
  }
  console.log(`candidates: delete=${del.length} keep=${actions.length - del.length} (manifest=${manifest})`);
  if (!args.apply) { console.log("DRY-RUN (no deletion). Add --apply to execute."); return; }
  if (args["tier-b-days"] !== undefined && !args["owner-ruling"]) throw new Error("tier B requested without --owner-ruling: retention law change is the owner's call");

  // child-first deletion order (schema fact: parent_id has no FK cascade — an
  // explicit parent row must never be removed before its children)
  const parentById = new Map(sessions.map((s) => [s.id, s.parentID]));
  const delById = new Map(del.map((a) => [a.id, a]));
  const ordered = orderChildFirst(del.map((a) => a.id), parentById).map((id) => delById.get(id));

  let ok = 0;
  let failed = 0;
  for (const a of ordered) {
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
