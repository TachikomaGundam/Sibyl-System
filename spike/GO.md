> 注：文中 "MAGI" 为项目曾用名，产品现已更名为 Sibyl-System（记录保留原名）。

# MAGI Milestone-0 Spike — **GO** ✅

**Date:** 2026-09-01 · **Env:** opencode **1.18.25** at `~/.local/bin/opencode` (task brief said 1.18.23 @ /usr/local/bin — stale; `which opencode` resolves to `.local/bin`), node **v22.22.1**.

## Verdict

**A standard opencode plugin tool CAN drive child LLM sessions to completion BY ITSELF** —
`ctx.client.session.create` + `ctx.client.session.prompt` (blocking), awaited inside the
tool's `execute()`, in a headless `opencode run --auto` subprocess. Parallel fan-out
(2 concurrent children via `Promise.all`) works. The lead run self-terminates normally
after the tool returns — **the OMO team_* mailbox failure mode does NOT occur with this
pattern**. This unblocks the self-hosted 3-voter council engine.

## Evidence (raw, in `evidence/` + `/tmp/magi-spike-run-{parallel,single}.log`)

| Assertion | Result | Evidence |
|---|---|---|
| (a) plugin loaded & tool visible | PASS | run log line: `⚙ magi_probe {"subject":"council-m0","mode":"parallel"}` |
| (b) tool returned ok:true, both parallel children, distinct markers | PASS | `"marker":"M0-councilm0-50guhi"` / `"M1-councilm0-ks888y"`, both `"markerEchoed": true`, `"ok": true` |
| (c) run self-terminated | PASS | exit_code=0 (no SIGKILL; timeout was 420s, actual 21s), `"exiting loop"` + `"disposing instance"` in log AFTER result text |
| (d) per-request model override accepted | PASS | both children: `"modelApplied": "acme-provider/acme-model-a"` (echoed from `data.info.providerID/modelID`), no schema error, `finishReason:"stop"` |
| (e) latency | parallel: totalLatencyMs=**3859** (children 2346 / 3858 — genuinely concurrent, total≈max); single: totalLatencyMs=**2809**. Outer wall: 21s / 19s incl. boot+lead model | `evidence/parallel-assertions.txt`, `single-assertions.txt` |
| (f) child session visibility | SKIPPED per plan (cost) — response payloads are sufficient | — |

Child sessions created (3 total, ≤4 budget): `ses_fa18d67e4ffetzzNX1S8tRaS8N`, `ses_fa18d67dfffew71FEqGExxObZP` (parallel), `ses_fa18c9e42ffeAwQTK2HD30hw21` (single). No parentID was passed and prompts still worked fine.

## FINAL working API shape (copy into the real plugin)

```js
// inside plugin server (ctx: PluginInput) — plain JS, tool() from @opencode-ai/plugin
const created = await ctx.client.session.create({
  body: { title: `magi ${marker}` },          // parentID OPTIONAL — omitting works
  query: { directory: ctx.directory },         // {directory} query is accepted & honored
})
if (created.error || !created.data?.id) { /* SDK never throws: check .error, data is .data */ }

const prompted = await ctx.client.session.prompt({
  path: { id: created.data.id },               // path param wrapper: { id }
  body: {
    model: { providerID: "acme-provider", modelID: "acme-model-a" }, // per-request override ✓
    // messageID NOT required; parts is REQUIRED and must be non-empty
    parts: [{ type: "text", text: promptText }],
    // available persona knobs (verified in types.gen.d.ts SessionPromptData):
    //   agent?: string      — route child to a named persona/agent (e.g. council member)
    //   system?: string     — per-request system prompt override
    //   tools?: {[name]: boolean} — per-prompt tool gating (voters: disable mutating tools)
    //   noReply?: boolean
  },
  query: { directory: ctx.directory },
})
// prompted.data = { info: AssistantMessage, parts: Part[] } — SYNCHRONOUS full result:
//   text = prompted.data.parts.filter(p => p.type === "text").map(p => p.text).join("")
//   modelApplied = `${prompted.data.info.providerID}/${prompted.data.info.modelID}`
//   child errors surface as prompted.data.info.error (finish: "stop" on success)
```

## Recommended engine contract (real MAGI plugin)

```ts
type PersonaRunResult = { text: string; ok: boolean; latencyMs: number
  sessionID: string; modelApplied: string | null; error?: string }

async function runPersona(
  client: PluginInput["client"], directory: string,
  persona: { agent?: string; system?: string; disallowedTools?: string[] },
  model: { providerID: string; modelID: string },
  inputText: string, timeoutMs = 240_000,
): Promise<PersonaRunResult> {
  const t0 = Date.now()
  const s = await withTimeout(client.session.create(
    { body: { title: `magi:${persona.agent ?? "persona"}`, ...(persona.parentID && { parentID: persona.parentID }) },
      query: { directory } }), timeoutMs, "create")
  if (s.error || !s.data?.id) return fail("session.create", s.error)
  const tools = Object.fromEntries((persona.disallowedTools ?? ["bash","edit","write"]).map(t => [t, false]))
  const r = await withTimeout(client.session.prompt({
    path: { id: s.data.id },
    body: { model, agent: persona.agent, system: persona.system, tools,
            parts: [{ type: "text", text: inputText }] },
    query: { directory } }), remaining(timeoutMs, t0), "prompt")
  /* extract text from r.data.parts; ALWAYS return, never throw out of execute() */
}
// Council: const votes = await Promise.all(personas.map(p => runPersona(...)))
// — Promise.all concurrency proven at n=2; n=3 is the same mechanism (no per-child cost
//   beyond an LLM request; all children ran inside the lead's server instance).
```

## Error-handling notes

- The generated SDK client **never throws on HTTP errors** — every call resolves
  `{data, error, response}`. Check `.error` after each stage; wrap only genuine
  exceptions (timeouts, aborts). Our probe returned `{ok:false, stage, error}` on any
  failure and never threw out of `execute()` (a throw would surface as a tool error to
  the lead, losing structured evidence).
- Empty/failed LLM reply surfaces as `info.error` (not `prompted.error`); verify both.
- `Promise.race` timeout guard per child (240s) keeps the tool from hanging the run.

## Surprises / gotchas (each cost a debugging cycle)

1. **Silent plugin load failure on bare-import resolution.** A path-registered plugin's
   `import { tool } from "@opencode-ai/plugin"` is resolved by Node/Bun upward from the
   **plugin file's directory** (`<WORKSPACE>/.../probe-plugin/node_modules` → ... → `<HOME>/node_modules`),
   NOT from opencode's bundle. a local model-routing plugin works only because `~/.config/opencode/node_modules/@opencode-ai/plugin`
   sits above it. Our magi/spike dir had no such ancestor → **zero error lines in logs at any
   level; tool simply absent from the model's toolset**. Fix used (no-install, read-only reuse):
   symlink `swarm/node_modules/@opencode-ai/{plugin,sdk}` + `.config/opencode/node_modules/zod`
   into `probe-plugin/node_modules/`. Runtime import chain is only `index→tool→zod`
   (`tool()` = identity, `tool.schema` = zod v4). For the real plugin: prefer
   `npm install --no-save @opencode-ai/plugin@1.15.13` inside the plugin dir, or ship under
   `~/.config/opencode/plugins/`. **Debug recipe:** in-run, ask the model to list its tools —
   plugin-tool absence with NO log error ⇒ import resolution.
2. **jsonc-parser array-item DELETION is corrupting** on comma-first formatted arrays
   (`,\n "entry"` style): `modify(text, ["plugin", idx], undefined)` produced
   `UnexpectedEndOfString@346` — it ate the array terminator. Registration INSERTION
   (`isArrayInsertion:true`) worked perfectly. Restore pattern that DID work:
   **replay-equivalence proof** (backup + insertion edit === current bytes) then byte-copy
   the backup. See `scripts/unregister.mjs` header.
3. Child sessions created with `parentID` omitted are top-level (`parentID=undefined` in
   the `message=created` log) and still prompt fine — the council does not need session
   hierarchy; use titles (`magi-spike <marker>`) for observability.
4. `query: {directory}` on both create/prompt is accepted by 1.18.25 (not in the 1.15.13
   typed body but harmless); providerID/modelID must exactly match config keys (all-lowercase
   `acme-provider`, `acme-model-a`). `messageID` not required. No auth quirks —
   children reused the parent process's provider credentials implicitly.
5. Headless `opencode run` exit code was 0 in all spike runs, but per project standing
   knowledge it stays **unreliable** — assertions were made on artifacts/logs only
   (`disposing instance` line + result JSON presence), never on rc alone.
6. Lead agent (OMO Sisyphus) obeyed "call tool exactly once, print verbatim" in both runs —
   council drivers can trust a thin orchestration prompt.

## Config restoration receipt

- Pre-spike plugin array: **6 entries** → registered spike entry: **7** → after restore: **6**.
- Restored file **byte-identical** to backup (`cmp` ✓), JSONC parses ✓, keys `$schema,plugin,provider` unchanged,
  probe entry absent (`evidence/final-config-assertion.txt`).
- Backup retained (dir convention): `~/.config/opencode/opencode.jsonc.bak.2026-09-01T19-26-02-439Z`.
- No `.tmp.*` residue; pgrep diff vs baseline shows no spike-owned processes (both spike runs
  self-disposed; new PIDs belong to an unrelated concurrent historian session — untouched).

## Artifacts

- `probe-plugin/{package.json,server.js}` — loadable probe plugin (magi_probe tool, single/parallel).
- `scripts/{register.mjs,unregister.mjs}` — JSONC-safe temp registration + verified restore (reusable for the real plugin's dev loop).
- `evidence/` — pgrep baseline/after, per-assertion grep extracts, full run logs, exit lines, restore assertion.
