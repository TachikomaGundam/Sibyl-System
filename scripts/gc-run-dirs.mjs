#!/usr/bin/env node
// gc-run-dirs: archive Sibyl lane/chamber run directories out of the run root
// (H3, council sibyl-20261114T101952Z-d820 must_fix 6/7). /tmp accumulation
// was measured at 657 dirs on 2026-11-13.
//
// Deviation named to the council (design D1): MOVE to a durable archive, not
// delete. The run dir is the only copy of transcript + CHECKSUMS and /tmp is
// volatile; deleting on success would trade loss-on-reboot for loss-on-close.
//
// Law (mechanical, fail-closed):
//  - only dirs whose realpath sits directly under the run root;
//  - only dirs owned by the current uid (no foreign artifacts are touched);
//  - only SEALED + TERMINAL dirs: CHECKSUMS.txt present AND run-record.json
//    parses with a terminal face that is not "running" (ballot H: the sweep's
//    DISPUTED face is wired to the terminal-record predicate, no convention);
//  - a grace window (--older-than-hours, default 24) keeps in-flight dirs;
//  - dry-run by default; --apply performs the move; EXDEV falls back to
//    recursive copy + remove.
//
// Usage: node scripts/gc-run-dirs.mjs [--root=/tmp] [--older-than-hours=24]
//        [--archive=<path>] [--apply]
// Crontab for the owner (installing cron is the owner's key; command only):
//   17 4 * * * node /home/<user>/workspace/harness/Sibyl/scripts/gc-run-dirs.mjs --apply >>$HOME/.sibyl/gc-run-dirs.log 2>&1

import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Pure planner (unit-tested). dir: {name, uidOk, sealed, terminal, ageMs}. */
export function planSweep(dirs, opts) {
  const { olderThanMs } = opts;
  return dirs.map((d) => {
    const keep = (reason) => ({ name: d.name, action: "keep", reason });
    if (!d.uidOk) return keep("not-owned-by-current-uid");
    if (!d.sealed) return keep("unsealed: no CHECKSUMS.txt (run may be in flight)");
    if (!d.terminal) return keep("non-terminal or unreadable run-record.json");
    if (d.ageMs < olderThanMs) return keep(`younger than grace window (${olderThanMs} ms)`);
    return { name: d.name, action: "move", reason: "sealed + terminal + past grace" };
  });
}

async function dirFacts(path, name, nowMs) {
  const st = await stat(path).catch(() => null);
  if (st === null) return null;
  const uidOk = typeof process.getuid === "function" ? st.uid === process.getuid() : true;
  const checksums = await stat(join(path, "CHECKSUMS.txt")).then(() => true, () => false);
  let terminal = false;
  try {
    const rec = JSON.parse(await readFile(join(path, "run-record.json"), "utf8"));
    terminal = typeof rec["terminal"] === "string" && rec["terminal"] !== "" && rec["terminal"] !== "running";
  } catch {
    terminal = false;
  }
  return { name, uidOk, sealed: checksums, terminal, ageMs: nowMs - st.mtimeMs };
}

/** move with cross-device fallback; dest collision gets a .dup-<ts> suffix. */
export async function moveDir(src, destRoot, nowMs = Date.now()) {
  await mkdir(destRoot, { recursive: true });
  const name = src.replace(/\/+$/, "").split("/").pop() ?? "run-dir";
  let dest = join(destRoot, name);
  try {
    await stat(dest);
    dest = join(destRoot, `${name}.dup-${String(nowMs)}`);
  } catch {
    /* free */
  }
  try {
    await rename(src, dest);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "EXDEV") {
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
  return dest;
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

export async function main(stdout = console) {
  const root = resolve(String(args.root ?? "/tmp"));
  const archive = resolve(String(args.archive ?? join(homedir(), ".sibyl", "chamber-archive")));
  const olderThanMs = Number(args["older-than-hours"] ?? 24) * 3_600_000;
  const nowMs = Date.now();
  const names = (await readdir(root)).filter((n) => n.startsWith("sibyl-run-"));
  const dirs = [];
  for (const name of names) {
    const path = join(root, name);
    const st = await stat(path).catch(() => null);
    if (st === null || !st.isDirectory()) continue;
    const real = await realpath(path).catch(() => path);
    if (!real.startsWith(root + "/")) continue; // symlink escape: not ours
    const facts = await dirFacts(path, name, nowMs);
    if (facts !== null) dirs.push({ ...facts, path });
  }
  const plan = planSweep(dirs, { olderThanMs });
  const moves = plan.filter((p) => p.action === "move");
  stdout.log(`sweep root=${root} candidates=${dirs.length} to-move=${moves.length} keep=${String(dirs.length - moves.length)} archive=${archive}`);
  for (const p of plan) if (p.action === "keep" && moves.length === 0) stdout.log(`  keep ${p.name}: ${p.reason}`);
  if (moves.length === 0) return { moved: [] };
  if (!args.apply) {
    for (const p of moves) stdout.log(`  DRY would move ${p.name}`);
    stdout.log("DRY-RUN (no move). Add --apply to archive.");
    return { moved: [] };
  }
  const moved = [];
  for (const p of moves) {
    const facts = dirs.find((d) => d.name === p.name);
    if (facts === undefined) continue;
    const dest = await moveDir(facts.path, archive);
    moved.push(dest);
    stdout.log(`  moved ${p.name} -> ${dest}`);
  }
  return { moved };
}

if (process.argv[1] && process.argv[1].endsWith("gc-run-dirs.mjs")) {
  main().catch((e) => {
    console.error(`gc-run-dirs refused: ${e.message}`);
    process.exit(1);
  });
}
