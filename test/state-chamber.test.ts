// provenance: v1.1 chamber-record tests — L6/L7 + A4 + A5 + E2 record law.
// Locks: single-line ledger parse incl. the MANDATORY merged-row rejection
// (A5), EOF-append serials, assertOnDisk drift refusal, face-last regeneration
// ordering (record written after checksums after artifact receipts), and the
// A4 spotcheck command surface + sha256sum -c actually passing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKSUMS_FILE,
  RECORD_FILE,
  appendLedgerRow,
  assertOnDisk,
  finalizeRecord,
  listChecksumTargets,
  loadLedger,
  parseLedgerLine,
  sha256File,
  spotcheckCommand,
  validateChamberRecord,
  type ArtifactRef,
  type ChamberRecord,
} from "../src/state/chamber.ts";

async function tmp(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sibyl-chamber-${label}-`));
}

function baseRecord(runDir: string, artifacts: ArtifactRef[] = []): ChamberRecord {
  const now = new Date().toISOString();
  return {
    schema: 1,
    runId: "sibyl-test-1",
    serial: 1,
    profile: "review",
    goal: "does the artifact hold",
    target: `${runDir}/target.md`,
    runDir,
    createdAt: now,
    updatedAt: now,
    terminal: null,
    roster: [{ role: "pro", slot: "default", modelId: "local-qwen/m", policyCheck: "allow" }],
    judgePool: ["local-qwen/m"],
    seed: "seed-abc",
    drawCommit: "f".repeat(64),
    judgeModelId: "local-qwen/m",
    rounds: 0,
    artifacts,
    evidenceRows: 0,
  };
}

async function artifact(runDir: string, rel: string, content: string): Promise<ArtifactRef> {
  const abs = join(runDir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
  const sha = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    role: rel.split("/")[0] ?? rel,
    round: 1,
    phase: "draft",
    relPath: rel,
    sha256: sha,
    bytes: Buffer.byteLength(content, "utf8"),
    presentAt: new Date().toISOString(),
    rc: 0,
    signal: null,
    timedOut: false,
  };
}

/* ── A5: merged-row guard + EOF serials ──────────────────────────────── */

test("parseLedgerLine: a valid single-doc line round-trips", async () => {
  const dir = await tmp("parse");
  const rec = baseRecord(dir);
  const v = parseLedgerLine(JSON.stringify(rec));
  assert.ok(v.ok, JSON.stringify(v));
});

test("parseLedgerLine: A5 merged-row fixture MUST fail (two docs on one line)", () => {
  const merged = `${JSON.stringify({ a: 1 })}${JSON.stringify({ b: 2 })}`;
  const v = parseLedgerLine(merged);
  assert.ok(!v.ok);
  assert.match(v.reason, /merged-row guard/);
  // also with a space separator — still exactly one doc per line expected
  assert.ok(!parseLedgerLine(`${JSON.stringify({ a: 1 })} ${JSON.stringify({ b: 2 })}`).ok);
});

test("parseLedgerLine: schema-invalid single docs are refused with a reason", () => {
  assert.ok(!parseLedgerLine(JSON.stringify({ schema: 999 })).ok);
  assert.ok(!parseLedgerLine("not json").ok);
  assert.ok(!parseLedgerLine("   ").ok);
});

test("appendLedgerRow: EOF append, serials increment, corrupt lines still consume serials", async () => {
  const dir = await tmp("ledger");
  const ledgerPath = join(dir, "chamber-ledger.jsonl");
  const a = await appendLedgerRow(ledgerPath, baseRecord(dir));
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.serial, 1);
  // a hand-injected corrupt line (as a tamper simulation) must not shift serial 2 onto an earlier identity
  await appendFile(ledgerPath, `${JSON.stringify({ a: 1 })}${JSON.stringify({ b: 2 })}\n`, "utf8");
  const b = await appendLedgerRow(ledgerPath, { ...baseRecord(dir), runId: "sibyl-test-2" });
  assert.ok(b.ok);
  if (!b.ok) return;
  assert.equal(b.serial, 3, "the corrupt line consumes serial 2 — later ids never shift back");
  const load = await loadLedger(ledgerPath);
  assert.equal(load.rows.length, 2, "both valid rows load");
  assert.equal(load.dropped.length, 1);
  assert.equal(load.dropped[0]?.line, 2);
  assert.match(load.dropped[0]?.reason ?? "", /merged-row guard/);
  // rows carry their recorded serial (not the load position)
  assert.equal(load.rows[0]?.runId, "sibyl-test-1");
  assert.equal(load.rows[1]?.runId, "sibyl-test-2");
  assert.equal(load.rows[1]?.serial, 3);
  // load on a missing ledger is empty, never fatal
  const none = await loadLedger(join(dir, "absent.jsonl"));
  assert.deepEqual(none, { rows: [], dropped: [] });
});

/* ── L7: assertOnDisk + face-last ordering ──────────────────────────── */

test("assertOnDisk: proven claim passes; drifted bytes and vanished file are refused", async () => {
  const dir = await tmp("assert");
  const art = await artifact(dir, "pro/draft.md", "# case\n");
  assert.ok((await assertOnDisk(join(dir, "pro/draft.md"), art)).ok);
  await writeFile(join(dir, "pro/draft.md"), "# case tampered\n", "utf8");
  const drift = await assertOnDisk(join(dir, "pro/draft.md"), art);
  assert.ok(!drift.ok);
  assert.match(drift.reason, /hash drift/);
  const gone = await assertOnDisk(join(dir, "nope.md"), { sha256: art.sha256, bytes: art.bytes });
  assert.ok(!gone.ok);
  assert.match(gone.reason, /read failed/);
});

test("finalizeRecord: drift refuses the face write entirely (no laundering)", async () => {
  const dir = await tmp("drift");
  const art = await artifact(dir, "con/attack.md", "charge 1\n");
  const rec = baseRecord(dir, [{ ...art, sha256: "0".repeat(64) }]); // lie about the hash
  const res = await finalizeRecord(rec);
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.drift.length, 1);
  // face must NOT exist — the refusal was total, not partial
  await assert.rejects(readFile(join(dir, RECORD_FILE), "utf8"));
});

test("finalizeRecord: clean run writes checksums then the face LAST; spotcheck verifies (A4)", async () => {
  const dir = await tmp("face");
  const ledgerPath = join(dir, "chamber-ledger.jsonl");
  const art = await artifact(dir, "pro/draft.md", "# case\nsolid\n");
  const rec = baseRecord(dir, [art]);
  const res = await finalizeRecord(rec, { writeLedger: { path: ledgerPath }, checksums: true });
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.ledgerSerial, 1);

  const targets = await listChecksumTargets(dir);
  // face + CHECKSUMS excluded; the ledger row is mirrored in-ledger-line.txt
  assert.deepEqual(targets, ["chamber-ledger.jsonl", "ledger-line.txt", "pro/draft.md"]);
  const mirrored = await readFile(join(dir, "ledger-line.txt"), "utf8");
  assert.ok(parseLedgerLine(mirrored).ok, "mirrored ledger row must itself parse (single doc)");
  const faceMtime = (await stat(join(dir, RECORD_FILE))).mtimeMs;
  const sumMtime = (await stat(join(dir, CHECKSUMS_FILE))).mtimeMs;
  assert.ok(faceMtime >= sumMtime, "face is regenerated as the terminal write (L7)");

  // A4: the exact human-facing command must verify every recorded byte.
  // sha256sum -c passes on the artifact; tampering is then detected.
  execFileSync("sha256sum", ["-c", CHECKSUMS_FILE], { cwd: dir, stdio: "pipe" });
  await writeFile(join(dir, "pro/draft.md"), "# case\nsubtly different\n", "utf8");
  assert.throws(() => execFileSync("sha256sum", ["-c", CHECKSUMS_FILE], { cwd: dir, stdio: "pipe" }));

  const spot = spotcheckCommand(dir);
  assert.equal(spot, `cd ${dir} && sha256sum -c ${CHECKSUMS_FILE}`);

  // face-last: run-record.json exists, is valid, and carries the serial the ledger assigned
  const face = JSON.parse(await readFile(join(dir, RECORD_FILE), "utf8"));
  const fv = validateChamberRecord(face);
  assert.ok(fv.ok, JSON.stringify(fv));
  assert.equal(fv.ok && fv.record.serial, 1);
  assert.ok(Date.parse(face.updatedAt) >= Date.parse(face.createdAt));

  const load = await loadLedger(ledgerPath);
  assert.equal(load.dropped.length, 0);
  assert.equal(load.rows.length, 1);
});

test("validateChamberRecord: hostile shapes refused element-wise, never fatal", () => {
  const dir = "/abs/run";
  assert.ok(!validateChamberRecord(null).ok);
  assert.ok(!validateChamberRecord([]).ok);
  assert.ok(!validateChamberRecord({ ...baseRecord(dir), serial: 0 }).ok);
  assert.ok(!validateChamberRecord({ ...baseRecord(dir), runDir: "relative/path" }).ok);
  assert.ok(!validateChamberRecord({ ...baseRecord(dir), terminal: "GONE_FISHING" }).ok);
  assert.ok(!validateChamberRecord({ ...baseRecord(dir), drawCommit: "nope" }).ok);
  assert.ok(!validateChamberRecord({ ...baseRecord(dir), seed: "" }).ok);
  const badArt = baseRecord(dir, [{ ...(baseRecord(dir).artifacts[0] ?? ({} as ArtifactRef)), relPath: "" }]);
  assert.ok(!validateChamberRecord(badArt).ok);
  assert.ok(validateChamberRecord({ ...baseRecord(dir), notes: "ok" }).ok);
});

test("sha256File: matches sha256sum for the same bytes; absence is structured", async () => {
  const dir = await tmp("hash");
  const p = join(dir, "x.md");
  await writeFile(p, "héllo 世界\n", "utf8");
  const h = await sha256File(p);
  assert.ok(h.ok);
  if (!h.ok) return;
  const cli = execFileSync("sha256sum", [p], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? "";
  assert.equal(h.sha256, cli);
  const missing = await sha256File(join(dir, "nope"));
  assert.ok(!missing.ok);
});

test("checksum surface excludes the role RUNTIME (sandbox homes/dbs/logs), keeps the review record", async () => {
  const dir = await tmp("surface");
  await mkdir(join(dir, "pro", "home", ".config"), { recursive: true });
  await writeFile(join(dir, "pro", "round-1.md"), "case\n", "utf8");
  await writeFile(join(dir, "pro", "prompt-r1-draft.md"), "prompt\n", "utf8");
  await writeFile(join(dir, "pro", "transcript-r1-draft.jsonl"), '{"e":1}\n', "utf8");
  await writeFile(join(dir, "pro", "home", "live.log"), "runtime\n", "utf8");
  await writeFile(join(dir, "pro", "home", ".config", "opencode.jsonc"), "{}\n", "utf8");
  await mkdir(join(dir, "pids"), { recursive: true });
  await writeFile(join(dir, "pids", "pro.pid"), "42\n", "utf8");
  await writeFile(join(dir, "pro", "session.db"), "SQLITEBIN", "utf8");
  const targets = await listChecksumTargets(dir);
  assert.deepEqual(targets, [
    "pro/prompt-r1-draft.md",
    "pro/round-1.md",
    "pro/transcript-r1-draft.jsonl",
  ]);
  assert.ok(!targets.some((t) => t.includes("/home/") || t.endsWith(".pid") || t.endsWith(".db")));
});
