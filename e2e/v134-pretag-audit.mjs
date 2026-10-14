// driver for law-4 pre-tag audit (round-3 face): calls the product tool core
// auditExecute directly; the ballots themselves are model-generated, the
// driver only eliminates an unreliable LLM caller. Fresh-root convener is the
// tool's own construction, not this script's.
import { createOpencodeClient } from "@opencode-ai/sdk";
import { auditExecute } from "../src/tools/audit.ts";
import { parseOptions } from "../src/options.ts";
import { toEngineClient } from "../src/index.ts";
import { RunStore } from "../src/state/index.ts";

const BASE = process.env["SIBYL_E2E_BASE"] ?? "http://127.0.0.1:CHANGE-ME";
const parsed = parseOptions({ modelPool: { default: { providerID: "local-qwen", modelID: "qwen3.8-flash-next" } }, timeoutMs: 420_000 });
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const client = toEngineClient(createOpencodeClient({ baseUrl: BASE }));
const out = await auditExecute(
  { client, store: new RunStore(), options: parsed.options },
  { artifact: "/tmp/opencode/sibyl-rel-v134/docs/release/v1.3.4.md", goal: "Round-4 pre-tag review: are the bc5c/a612/9f35 findings all resolved on this face, and is the packet publishable as the v1.3.4 shipping record? Separate blocking defects from NON-BLOCKING notes; one line per reason, 20 lines max." },
  { directory: "/tmp/opencode/sibyl-rel-v134", abort: new AbortController().signal, sessionID: "" },
);
console.log(out);
