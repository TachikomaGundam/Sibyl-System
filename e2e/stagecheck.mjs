// Pre-council dry run of the W1-v2 lineage law: predicts the instrument's own
// verdict on a staged artifact from the live engine store, in seconds.
// Usage: SIBYL_E2E_BASE=http://127.0.0.1:<port> node --import ./tools/register-ts.mjs e2e/stagecheck.mjs <artifact> <session>
import { readFileSync, statSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { partCandidates, previewLineage } from "../src/independence.ts";

const [artifactPath, convenerID] = process.argv.slice(2);
if (!artifactPath || !convenerID) { console.error("usage: stagecheck <artifact> <session>"); process.exit(2); }
const base = process.env.SIBYL_E2E_BASE;
if (!base) { console.error("SIBYL_E2E_BASE unset"); process.exit(2); }
const client = createOpencodeClient({ baseUrl: base });
const text = readFileSync(artifactPath, "utf8");
const mtimeMs = statSync(artifactPath).mtimeMs;

const chain = [convenerID];
const readErrors = [];
let cur = convenerID;
for (let d = 0; d < 16; d += 1) {
  const r = await client.session.get({ path: { id: cur } });
  if (r?.error !== undefined || r?.data === undefined) { readErrors.push(`session.get(${cur})`); break; }
  const parent = r.data.parentID ?? "";
  if (!parent || chain.includes(parent)) break;
  chain.push(parent); cur = parent;
}

const parts = [];
let skippedAfterMtime = 0, timeless = 0;
for (const sid of chain) {
  const res = await client.session.messages({ path: { id: sid }, query: { directory: process.cwd() } });
  if (res?.error !== undefined || res?.data === undefined) { readErrors.push(`messages(${sid})`); continue; }
  for (const [mi, m] of res.data.entries()) {
    for (const raw of m.parts ?? []) {
      const p = { type: raw.type, tool: raw.tool, input: raw.input ?? raw.state?.input };
      const cands = partCandidates(p);
      if (cands.length === 0) continue;
      const t = m?.info?.time?.created;
      if (typeof t !== "number") { timeless += 1; continue; }
      if (t > mtimeMs) { skippedAfterMtime += 1; continue; }
      parts.push({ time: t, cands });
    }
  }
}

if (readErrors.length > 0) {
  console.log(`stagecheck: UNVERIFIABLE — reads refused: ${readErrors.join(", ")} (a failed dry run never predicts independence)`);
  process.exit(3);
}
const v = previewLineage(text, mtimeMs, parts);
console.log(`stagecheck: ${v.status}`);
console.log(`  face: ${v.face}`);
console.log(`  stats: ${v.stats}`);
console.log(`  parts: ${String(parts.length)} pre-mtime credited, ${String(skippedAfterMtime)} post-mtime skipped, ${String(timeless)} timeless; chain depth ${String(chain.length)}`);
process.exit(0);
