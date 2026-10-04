// provenance: W2 absence-as-disability unit locks for src/terminal.ts.
// Row grammar (task=/status= parseable, last-per-task wins, malformed lines
// skipped never fatal), timeout-vs-error classification, one-line sanitize,
// and the dead-without-record declaration diff.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFailure,
  deadFaceCount,
  deadWithoutRecord,
  formatTerminalRow,
  parseTerminalRows,
  sanitizeDetail,
} from "../src/terminal.ts";

const at = new Date("2026-10-04T12:00:00.000Z");

test("row roundtrip: format then parse yields the same fields", () => {
  const line = formatTerminalRow(at, { task: "t1", worker: "worker-0-t1", status: "ok", session: "sess-3", detail: "draft=/space/t1.md" });
  assert.ok(line.startsWith("ts=2026-10-04T12:00:00.000Z task=t1 worker=worker-0-t1 status=ok session=sess-3 detail="), line);
  const rows = parseTerminalRows(`${line}\n`);
  const row = rows.get("t1");
  assert.ok(row !== undefined);
  assert.equal(row.status, "ok");
  assert.equal(row.worker, "worker-0-t1");
  assert.equal(row.session, "sess-3");
  assert.equal(row.detail, "draft=/space/t1.md");
});

test("empty session renders as '-' (no bare key confusion)", () => {
  const line = formatTerminalRow(at, { task: "t9", worker: "w", status: "error", session: "", detail: "x" });
  assert.ok(line.includes("session=- "), line);
});

test("parse: malformed lines skipped, last row per task wins (resume appends)", () => {
  const rows = parseTerminalRows(
    [
      "this line has no fields",
      "ts=x task=t1 status=bogus detail=unknown vocabulary",
      "ts=1 task=t1 status=error detail=first pass died",
      "ts=2 task=t1 status=ok detail=resumed fine",
      "ts=3 task=t2 status=timeout detail=budget",
      "",
    ].join("\n"),
  );
  assert.equal(rows.size, 2);
  assert.equal(rows.get("t1")?.status, "ok");
  assert.equal(rows.get("t1")?.detail, "resumed fine");
  assert.equal(rows.get("t2")?.status, "timeout");
});

test("classifyFailure: timeout words are ruler wounds, everything else engine error", () => {
  assert.equal(classifyFailure("session.prompt timeout after 240000ms"), "timeout");
  assert.equal(classifyFailure("Timed out waiting for the deadline"), "timeout");
  assert.equal(classifyFailure("fetch failed"), "error");
  assert.equal(classifyFailure("empty-reply: no content"), "error");
});

test("sanitizeDetail: one line, capped at 240 chars with ellipsis", () => {
  const flat = sanitizeDetail("line one\nline\ttwo   spaced");
  assert.equal(flat, "line one line two spaced");
  const long = sanitizeDetail("x".repeat(500));
  assert.equal(long.length, 241);
  assert.ok(long.endsWith("…"));
});

test("deadWithoutRecord: declared minus recorded, order kept, extras ignored", () => {
  const rows = parseTerminalRows("ts=1 task=t2 status=ok detail=x\nts=2 task=t9 status=ok detail=x\n");
  assert.deepEqual(deadWithoutRecord(["t1", "t2", "t3"], rows), ["t1", "t3"]);
  assert.deepEqual(deadWithoutRecord([], rows), []);
});

test("deadFaceCount renders the receipt-face label", () => {
  assert.equal(deadFaceCount(["t1", "t2", "t3"]), "dead-without-record=3");
  assert.equal(deadFaceCount([]), "dead-without-record=0");
});
