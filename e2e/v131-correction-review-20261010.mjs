// Independent validation round (post-hardening): a FRESH root session (no
// drafting kinship) consults on the hardened W4 suite. Expect
// independence=INDEPENDENT so the ballot legitimately enters the effective
// path; its verdict is recorded and read back here.
import { homedir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
const SEAT = process.env["SIBYL_E2E_SEAT"] ?? homedir();
const REPO = `${SEAT}/workspace/harness/Sibyl`;
import { consultExecute } from "../src/tools/consult.ts";
import { parseOptions } from "../src/options.ts";
import { toEngineClient } from "../src/index.ts";
import { RunStore } from "../src/state/index.ts";
const DIR = REPO;
const ART = `${REPO}/docs/release/v1.3.1.md`;
const BASE = process.env["SIBYL_E2E_BASE"] ?? "http://127.0.0.1:CHANGE-ME";
const client = createOpencodeClient({ baseUrl: BASE });
const parsed = parseOptions({ modelPool: { default: { providerID: process.env["SIBYL_E2E_PROVIDER"] ?? "", modelID: process.env["SIBYL_E2E_MODEL"] ?? "" } }, timeoutMs: 480_000 });
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const created = await client.session.create({ body: { title: "v131-correction-reviewer" }, query: { directory: DIR } });
const sid = created.data?.id;
if (!sid) throw new Error("no session");
const out = await consultExecute({ client: toEngineClient(client), store: new RunStore(), options: parsed.options }, { artifact: ART, goal: "Does this corrected release receipt (ballot 526d must-fixes answered, owner ruling recorded by verbatim quote, self-labels in place) now read as an honest, evidence-forward packet face? Judge the current text only. Keep every reason to one line and the whole reply under 25 lines." }, { directory: DIR, abort: new AbortController().signal, sessionID: sid });
console.log(out.split("\n").slice(0, 3).join("\n"));
const runs = await new RunStore().load();
const runId = (out.match(/run (sibyl-[0-9TZ-]+-[0-9a-f]+)/) ?? [])[1];
const rec = runs.find((r) => r.runId === runId);
console.log(`CORRECTION-REVIEW run=${runId} independence=${rec?.independence?.status} verdict=${rec?.verdict?.verdict} (${rec?.verdict.approvals}A/${rec?.verdict.rejects}R/${rec?.verdict.errors}E/${rec?.verdict.missing}M) rules=${rec?.instrument?.rulesHash.slice(0, 12)}`);
await client.session.delete({ path: { id: sid } }).catch(() => undefined);
