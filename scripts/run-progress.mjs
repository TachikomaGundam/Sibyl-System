#!/usr/bin/env node
// run-progress.mjs — read-only progress surface for in-flight and recent Sibyl runs.
// Product gap closed (seat-observed 2026-11-16 during E0 sentinel debugging): while
// a council run was in flight there was no user-facing way to watch it — nothing
// user-facing read the ledger while status="running", even though createRun()
// persists a "running" record up front and voter replies land in the run space
// as votes complete. This script exposes exactly that, reading ONLY:
//   $SIBYL_STATE_FILE or <sibylHome>/runs.json   (record.status "running" = in-flight)
//   record.spaceDir/                              (voter reply files landing live)
// It never opens the engine DB and never writes any state.
// Exit codes: 0 ok, 2 no state file / unreadable / bad usage, 3 --run not found.
// Usage:
//   node scripts/run-progress.mjs [--home <sibylHome>] [--run <runId>] [--json] [--limit N]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json" || a === "--help") { flags.set(a.slice(2), true); continue; }
  if (a.startsWith("--")) flags.set(a.slice(2), argv[++i]);
}
if (flags.has("help")) {
  console.log("usage: run-progress [--home <sibylHome>] [--run <runId>] [--json] [--limit N]");
  process.exit(0);
}
// sibyl home: explicit --home, else ~/.sibyl; SIBYL_STATE_FILE overrides the file only.
const home = flags.get("home") ?? join(homedir(), ".sibyl");
const stateFile = process.env.SIBYL_STATE_FILE ?? join(home, "runs.json");
if (!existsSync(stateFile)) {
  console.error(`no runs file at ${stateFile} (set --home or SIBYL_STATE_FILE)`);
  process.exit(2);
}
let records = [];
try {
  const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  records = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  console.error(`runs file unreadable: ${stateFile}`);
  process.exit(2);
}
const verdictText = (v) => v == null ? "-" : typeof v === "string" ? v : String(v.tag ?? JSON.stringify(v));
const runId = flags.get("run");
let rows = records
  .filter((r) => r && typeof r === "object" && typeof r.runId === "string")
  .filter((r) => (runId ? r.runId === runId || r.runId.endsWith(runId) : true))
  .map((r) => {
    let files = [];
    try {
      files = r.spaceDir && existsSync(r.spaceDir)
        ? readdirSync(r.spaceDir)
            .filter((f) => !f.startsWith("."))
            .map((f) => {
              const st = statSync(join(r.spaceDir, f));
              return { name: f, bytes: st.size, mtime: st.mtime.toISOString() };
            })
        : [];
    } catch { /* read-only best effort */ }
    const created = Date.parse(r.createdAt ?? "");
    const elapsedSec = Number.isFinite(created) ? Math.round((Date.now() - created) / 1000) : null;
    return {
      runId: r.runId,
      kind: r.kind ?? "?",
      status: r.status ?? "?",
      verdict: r.verdict ?? null,
      elapsedSec,
      createdAt: r.createdAt ?? null,
      updatedAt: r.updatedAt ?? null,
      reclaim: r.reclaim ?? null,
      files,
    };
  });
if (runId && rows.length === 0) {
  console.error(`run not found: ${runId} (in ${stateFile})`);
  process.exit(3);
}
rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const limit = Math.max(1, Number(flags.get("limit") ?? 10) || 10);
const shown = rows.slice(0, limit);
if (flags.get("json")) {
  console.log(JSON.stringify({ stateFile, total: rows.length, inFlight: rows.filter((r) => r.status === "running").length, rows: shown }, null, 1));
  process.exit(0);
}
const inflight = rows.filter((r) => r.status === "running").length;
console.log(`# sibyl progress — ${stateFile}`);
console.log(`# records: ${String(rows.length)}  in-flight: ${String(inflight)}  shown: ${String(shown.length)}`);
for (const r of shown) {
  const mark = r.status === "running" ? "  <-- IN FLIGHT" : "";
  console.log(`${r.runId}  ${r.kind}  ${r.status}  verdict=${verdictText(r.verdict)}  files=${String(r.files.length)}  elapsed=${String(r.elapsedSec ?? "?")}s  updated=${r.updatedAt ?? "?"}${mark}`);
  if (r.status === "running" || runId) {
    for (const f of r.files) console.log(`    ${f.name}  ${String(f.bytes)}B  ${f.mtime}`);
  }
}
