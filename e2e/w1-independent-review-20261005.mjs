// Independent validation round (post-hardening): a FRESH root session (no
// drafting kinship) consults on the hardened W4 suite. Expect
// independence=INDEPENDENT so the ballot legitimately enters the effective
// path; its verdict is recorded and read back here.
import { createOpencodeClient } from "@opencode-ai/sdk";
import { consultExecute } from "<home>/workspace/harness/Sibyl/src/tools/consult.ts";
import { parseOptions } from "<home>/workspace/harness/Sibyl/src/options.ts";
import { toEngineClient } from "<home>/workspace/harness/Sibyl/src/index.ts";
import { RunStore } from "<home>/workspace/harness/Sibyl/src/state/index.ts";
const DIR = "<home>/workspace/harness/Sibyl";
const ART = `${DIR}/test/hook-prepush.test.ts`;
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:19923" });
const parsed = parseOptions({ modelPool: { default: { providerID: "local-qwen", modelID: "qwen3.8-flash-next" } }, timeoutMs: 480_000 });
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const created = await client.session.create({ body: { title: "w1-independent-reviewer" }, query: { directory: DIR } });
const sid = created.data?.id;
if (!sid) throw new Error("no session");
const out = await consultExecute({ client: toEngineClient(client), store: new RunStore(), options: parsed.options }, { artifact: ART, goal: "Is this hardened W4 regression suite an adequate lock on the object-body release law (every fact from the tag object, every ref line policed, crash distinct from refusal)?" }, { directory: DIR, abort: new AbortController().signal, sessionID: sid });
console.log(out.split("\n").slice(0, 3).join("\n"));
const runs = await new RunStore().load();
const runId = (out.match(/run (sibyl-[0-9TZ-]+-[0-9a-f]+)/) ?? [])[1];
const rec = runs.find((r) => r.runId === runId);
console.log(`REVIEW run=${runId} independence=${rec?.independence?.status} verdict=${rec?.verdict?.verdict} (${rec?.verdict.approvals}A/${rec?.verdict.rejects}R/${rec?.verdict.errors}E/${rec?.verdict.missing}M) rules=${rec?.instrument?.rulesHash.slice(0, 12)}`);
await client.session.delete({ path: { id: sid } }).catch(() => undefined);
