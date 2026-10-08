// W1-v2 live proof (2026-10-08): the 526d canonical case re-adjudicated by the
// content-lineage leg against the REAL engine store; TEMPLATE.md as control.
import { homedir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { toEngineClient } from "../src/index.ts";
import { assessIndependence } from "../src/independence.ts";
import { readArtifact } from "../src/tools/shared.ts";

const BASE = process.env["SIBYL_E2E_BASE"] ?? "http://127.0.0.1:CHANGE-ME";
const CONVENING_SEAT = "ses_ef89d416fffeevA2GXZNq6NhlJ";
const engine = toEngineClient(createOpencodeClient({ baseUrl: BASE }));
const repo = `${homedir()}/workspace/harness/Sibyl`;

const live = await readArtifact(`${repo}/docs/release/v1.3.1.md`, repo);
if (!live.ok) throw new Error(`artifact: ${live.error}`);
const v = await assessIndependence(engine, repo, CONVENING_SEAT, live);
console.log(`526d-replay: ${v.status}`);
console.log(`  evidence: ${v.evidence}`);

const control = await readArtifact(`${repo}/docs/release/TEMPLATE.md`, repo);
if (!control.ok) throw new Error(`control: ${control.error}`);
const c = await assessIndependence(engine, repo, CONVENING_SEAT, control);
console.log(`control(TEMPLATE.md): ${c.status}`);
console.log(`  evidence: ${c.evidence}`);
