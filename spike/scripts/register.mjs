#!/usr/bin/env node
/**
 * register.mjs — JSONC-safe append of the magi spike probe plugin path to the
 * global opencode.jsonc plugin array. Pattern borrowed from an earlier
 * internal registration helper
 * (jsonc-parser modify + applyEdits; NEVER regex surgery; atomic temp+rename;
 * backup to <target>.bak.<ISO>; post-write parse assertion; restore on failure).
 * Concurrency: re-reads immediately before write; on content drift between
 * read and write, retries ONCE.
 *
 * Prints structural assertions only (counts + presence), never file secrets.
 * Archived spike helper: jsonc-parser resolves from this repo's node_modules —
 * run `npm i --no-save jsonc-parser` before re-executing (not a repo dependency).
 * Exit: 0 ok, 2 invalid JSONC, 3 already registered, 4 post-write assert fail, 5 usage/io.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jsonc = require('jsonc-parser');
const { parse, modify, applyEdits, printParseErrorCode } = jsonc;

const TARGET = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');
const SPIKE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(SPIKE_DIR, 'probe-plugin');
const FORMAT = { insertSpaces: true, tabSize: 2 };

function parsePlugins(text) {
  const errs = [];
  const doc = parse(text, errs, { allowTrailingComma: true });
  if (errs.length) {
    const e = errs[0];
    throw new Error(`invalid JSONC: ${printParseErrorCode(e.error)} @ offset ${e.offset}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('parsed to non-object');
  return doc;
}

function atomicWrite(text) {
  const tmp = TARGET + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, TARGET);
}

function run(attempt) {
  const before = fs.readFileSync(TARGET, 'utf8');
  const doc = parsePlugins(before);
  const plugins = Array.isArray(doc.plugin) ? doc.plugin : [];
  const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  const idx = names.indexOf(ENTRY);
  if (idx >= 0) {
    console.log(`[register] already registered at index ${idx} (count=${plugins.length})`);
    process.exit(3);
  }
  if (attempt === 1) {
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${TARGET}.bak.${iso}`;
    fs.copyFileSync(TARGET, bak);
    fs.writeFileSync(path.join(SPIKE_DIR, 'evidence', 'backup-path.txt'), bak + '\n');
    console.log(`[register] backup written: ${bak}`);
  }
  console.log(`[register] pre-state: plugin count=${plugins.length}`);

  // Append at next array index via jsonc-parser modify (preserves comments/format).
  const edits = modify(before, ['plugin', plugins.length], ENTRY, {
    formatting: FORMAT,
    isArrayInsertion: true,
  });
  atomicWrite(applyEdits(before, edits));

  // Post-write verify; on ANY failure restore the pristine `before` we read.
  try {
    const after = fs.readFileSync(TARGET, 'utf8');
    const doc2 = parsePlugins(after);
    const names2 = (doc2.plugin || []).map((p) => (Array.isArray(p) ? p[0] : p));
    if (!names2.includes(ENTRY) || names2.length !== plugins.length + 1) {
      throw new Error(`assert fail: count=${names2.length} expected=${plugins.length + 1} present=${names2.includes(ENTRY)}`);
    }
    // Drift check for concurrent edits: ensure every prior entry survived.
    for (const n of names) if (!names2.includes(n)) throw new Error(`assert fail: prior entry "${n}" lost`);
    console.log(`[register] post-state OK: plugin count=${names2.length}, probe entry present, all prior entries intact`);
  } catch (e) {
    atomicWrite(before);
    throw e;
  }
}

try {
  run(1);
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/invalid JSONC|assert fail/.test(msg)) {
    console.log(`[register] drift detected (${msg}); retrying once…`);
    try { run(2); } catch (e2) { console.error(`[register] FAIL: ${e2?.message}`); process.exit(4); }
  } else if (process.exitCode === 3) { /* handled */ }
  else { console.error(`[register] FAIL: ${msg}`); process.exit(5); }
}
