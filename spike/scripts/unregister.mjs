#!/usr/bin/env node
/**
 * unregister.mjs — restore opencode.jsonc from the spike backup.
 *
 * Safety contract:
 *  1. PROVE the current file is exactly `backup + spike insertion` by replaying
 *     register.mjs's jsonc-parser insertion on the backup bytes and comparing
 *     to current. Only then is a byte copy-back provably lossless (no
 *     concurrent edits are clobbered).
 *  2. If the replay does NOT match (someone edited the file during the spike),
 *     refuse to copy back; the operator must resolve drift manually.
 *     (Note: jsonc-parser item-DELETION is unusable on this file's comma-first
 *     formatting — it corrupts the array. Verified 2026-09-01; hence replay-
 *     equivalence + copy-back instead of surgical removal.)
 *  3. Post-restore: file parses, plugin count == backup count, probe entry gone.
 * Archived spike helper: jsonc-parser resolves from this repo's node_modules —
 * run `npm i --no-save jsonc-parser` before re-executing (not a repo dependency).
 * Exit: 0 restored|absent, 4 assert/drift fail, 5 io/parse fail.
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
const BACKUP = fs.readFileSync(path.join(SPIKE_DIR, 'evidence', 'backup-path.txt'), 'utf8').trim();
const FORMAT = { insertSpaces: true, tabSize: 2 };

function parseDoc(text) {
  const errs = [];
  const doc = parse(text, errs, { allowTrailingComma: true });
  if (errs.length) throw new Error(`invalid JSONC: ${printParseErrorCode(errs[0].error)} @ ${errs[0].offset}`);
  return doc;
}
const names = (doc) => (doc.plugin || []).map((p) => (Array.isArray(p) ? p[0] : p));

const backupText = fs.readFileSync(BACKUP, 'utf8');
const backupNames = names(parseDoc(backupText));

const cur = fs.readFileSync(TARGET, 'utf8');
const curNames = names(parseDoc(cur));
if (!curNames.includes(ENTRY)) {
  if (JSON.stringify(curNames) === JSON.stringify(backupNames)) {
    console.log('[unregister] already restored (count=%d, byte-state == backup set)', curNames.length);
    process.exit(0);
  }
  console.error('[unregister] probe entry absent BUT name-set differs from backup — leaving file untouched');
  console.error('[unregister] current=%j backup=%j', curNames, backupNames);
  process.exit(4);
}

// 1. Replay-equivalence proof
const replay = applyEdits(backupText, modify(backupText, ['plugin', backupNames.length], ENTRY, { formatting: FORMAT, isArrayInsertion: true }));
if (replay !== cur) {
  console.error('[unregister] DRIFT: current file != backup + spike insertion. Refusing copy-back.');
  console.error(`[unregister] replay=${replay.length}B current=${cur.length}B`);
  process.exit(4);
}
console.log('[unregister] replay-equivalence PROVEN: current == backup + spike insertion (byte-identical)');

// 2. Atomic byte restore
const tmp = TARGET + `.tmp.${process.pid}`;
fs.writeFileSync(tmp, backupText, 'utf8');
fs.renameSync(tmp, TARGET);

// 3. Post-restore assertions
const after = fs.readFileSync(TARGET, 'utf8');
const afterNames = names(parseDoc(after));
if (after !== backupText || afterNames.length !== backupNames.length || afterNames.includes(ENTRY)) {
  console.error('[unregister] POST-RESTORE ASSERT FAIL');
  process.exit(4);
}
console.log(`[unregister] RESTORED OK: plugin count=${afterNames.length} == pre-spike ${backupNames.length}, probe entry absent, JSONC parses, bytes == backup`);
