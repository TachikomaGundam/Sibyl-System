// W1 live e2e v3 (2026-10-05): replay the REAL incident store on a temporary
// `opencode serve` (19923). POSITIVE (run f68c, completed): this seat's root
// session convened a consult on a file its own chain wrote -> the instrument
// stamped NOT-INDEPENDENT with the write-part citation (the 91fc incident
// shape, refused live). CONTROL (this leg): a fresh root session with no
// drafting history convenes the same consult -> must read INDEPENDENT.
// A prior control attempt froze at `running` when the driving shell died —
// that record is kept (honest face) and its session deleted after this leg.
import { readFileSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk";

import { consultExecute } from "<home>/workspace/harness/Sibyl/src/tools/consult.ts";
import { parseOptions } from "<home>/workspace/harness/Sibyl/src/options.ts";
import { toEngineClient } from "<home>/workspace/harness/Sibyl/src/index.ts";
import { RunStore } from "<home>/workspace/harness/Sibyl/src/state/index.ts";

const BASE = "http://127.0.0.1:19923";
const DIR = "<home>/workspace/harness/Sibyl";
const ART_PATH = "<home>/workspace/harness/Sibyl/test/hook-prepush.test.ts";
const OLD_CONTROL = process.argv[2];

const client = createOpencodeClient({ baseUrl: BASE });
const parsed = parseOptions({ modelPool: { default: { providerID: "local-qwen", modelID: "qwen3.8-flash-next" } }, timeoutMs: 480_000 });
if (!parsed.ok) throw new Error(`options: ${parsed.errors.join("; ")}`);
const engine = toEngineClient(client);
const store = new RunStore();

const created = await client.session.create({ body: { title: "w1-e2e-control-root2" }, query: { directory: DIR } });
const ctrl = created.data?.id;
if (!ctrl) throw new Error(`control create failed: ${JSON.stringify(created)}`);
console.log("[e2e CONTROL2] session:", ctrl);
const out2 = await consultExecute({ client: engine, store, options: parsed.options }, { artifact: ART_PATH, goal: "Does this W4 hook test suite hold up?" }, { directory: DIR, abort: new AbortController().signal, sessionID: ctrl });
console.log("[e2e CONTROL2]\n" + out2.split("\n").slice(0, 2).join("\n"));

const runs = await store.load();
const runId = (out2.match(/run (sibyl-[0-9TZ-]+-[0-9a-f]+)/) ?? [])[1];
const rec = runs.find((r) => r.runId === runId);
const rows = (() => { try { return readFileSync(`${rec?.spaceDir}/TERMINALS.txt`, "utf8").trim().split("\n").length; } catch { return "n/a"; } })();
console.log(`[e2e CONTROL2] run=${runId} independence=${rec?.independence?.status} chain=${JSON.stringify(rec?.independence?.convenerChain)}`);
console.log(`[e2e CONTROL2] verdict=${rec?.verdict?.verdict} rules=${rec?.instrument?.rulesHash?.slice(0, 12)} terminal_rows=${rows}`);
if (OLD_CONTROL) await client.session.delete({ path: { id: OLD_CONTROL } }).catch(() => undefined);
await client.session.delete({ path: { id: ctrl } }).catch(() => undefined);
console.log("[e2e] control sessions cleaned (voter children cascade); f68c evidence rows keep their nested voters under the drafting seat.");
