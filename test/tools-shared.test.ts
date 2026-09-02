// provenance: original clean-room Sibyl-System implementation (plan task 8), no swarm
// code copied.
//
// Slot-resolution matrix (the single source of truth both tools share) and the
// artifact reader: inline-vs-path rule, 256 KiB cap, readable errors, and the
// never-throw promise. No `as any`; exactOptionalPropertyTypes-safe literals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARTIFACT_MAX_BYTES, readArtifact, runInSession, slotForModel } from "../src/tools/shared.ts";
import type { ModelSlot } from "../src/swarm/types.ts";

const A: ModelSlot = { providerID: "pa", modelID: "ma" };
const B: ModelSlot = { providerID: "pb", modelID: "mb" };
const D: ModelSlot = { providerID: "pd", modelID: "md" };
const POOL: Record<string, ModelSlot> = { default: D, melchior: A, architect: B };

test("slotForModel: override slot (non-default, present) wins over persona slot", () => {
  assert.deepEqual(slotForModel(POOL, "melchior", "architect"), A);
});

test('slotForModel: the "default" sentinel never masks the persona slot', () => {
  assert.deepEqual(slotForModel(POOL, "default", "architect"), B);
});

test("slotForModel: unknown override slot falls through to persona slot (never fatal)", () => {
  assert.deepEqual(slotForModel(POOL, "nope", "architect"), B);
});

test("slotForModel: unknown persona slot falls through to pool default", () => {
  assert.deepEqual(slotForModel(POOL, undefined, "ghost"), D);
});

test("slotForModel: absent override + absent persona slot resolve to pool default", () => {
  assert.deepEqual(slotForModel(POOL, undefined, undefined), D);
});

test("slotForModel: persona slot beats pool default when present", () => {
  assert.deepEqual(slotForModel(POOL, undefined, "melchior"), A);
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sibyl-t8-shared-"));
}

test("readArtifact: multi-line value is inline content with a byte-count source", async () => {
  const r = await readArtifact("line one\nline two", "/cwd/ignored");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.kind, "inline");
  assert.equal(r.text, "line one\nline two");
  assert.equal(r.source, "<inline: 17 bytes>");
});

test("readArtifact: regular file under the cap is read with its absolute path", async () => {
  const dir = await tempDir();
  const path = join(dir, "art.md");
  await writeFile(path, "# hello sibyl", "utf8");
  const r = await readArtifact(path, dir);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.kind, "path");
  assert.equal(r.source, path);
  assert.equal(r.text, "# hello sibyl");
});

test("readArtifact: relative path resolves against the cwd argument", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "rel.txt"), "x", "utf8");
  const r = await readArtifact("rel.txt", dir);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.source, join(dir, "rel.txt"));
});

test("readArtifact: over-cap file yields a readable error, never a throw", async () => {
  const dir = await tempDir();
  const path = join(dir, "big.bin");
  await writeFile(path, Buffer.alloc(ARTIFACT_MAX_BYTES + 1, 0x61), "utf8");
  const r = await readArtifact(path, dir);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.includes("exceeds"), r.error);
  assert.ok(r.error.includes(String(ARTIFACT_MAX_BYTES)), r.error);
});

test("readArtifact: missing path / directory / empty input all yield readable errors", async () => {
  const dir = await tempDir();
  const missing = await readArtifact(join(dir, "nope.txt"), dir);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.error.includes("nope.txt"), missing.error);

  const isDir = await readArtifact(dir, "/");
  assert.equal(isDir.ok, false);
  if (!isDir.ok) assert.ok(isDir.error.includes("not a regular file"), isDir.error);

  const empty = await readArtifact("   ", dir);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok(empty.error.includes("empty"), empty.error);
});

test("runInSession: happy follow-up joins text parts and reports the model", async () => {
  const seen: { id: string; text: string; tools: Record<string, boolean> }[] = [];
  const r = await runInSession(
    {
      session: {
        async create() {
          return { data: { id: "unused" } };
        },
        async prompt(args) {
          seen.push({ id: args.path.id, text: args.body.parts[0]?.text ?? "", tools: args.body.tools });
          return { data: { info: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "OK " }, { type: "text", text: "JSON" }] } };
        },
      },
    },
    "/d",
    "sess-9",
    A,
    "repair now",
    5_000,
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, "OK JSON");
  assert.equal(r.sessionID, "sess-9");
  assert.equal(r.modelApplied, "p/m");
  assert.equal(seen[0]?.id, "sess-9");
  assert.equal(seen[0]?.text, "repair now");
  assert.deepEqual(seen[0]?.tools, { bash: false, edit: false, write: false });
});

test("runInSession: client throw and info.error collapse to ok:false, never reject", async () => {
  const broken = await runInSession(
    {
      session: {
        async create() {
          return { data: { id: "x" } };
        },
        async prompt() {
          throw new Error("socket hangup");
        },
      },
    },
    "/d",
    "sess-e",
    A,
    "t",
    5_000,
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.error, "socket hangup");

  const llmError = await runInSession(
    {
      session: {
        async create() {
          return { data: { id: "x" } };
        },
        async prompt() {
          return { data: { info: { error: { name: "ProviderAuthError" } }, parts: [] } };
        },
      },
    },
    "/d",
    "sess-a",
    A,
    "t",
    5_000,
  );
  assert.equal(llmError.ok, false);
  assert.ok(llmError.error !== undefined && llmError.error.includes("ProviderAuthError"), llmError.error);
});
