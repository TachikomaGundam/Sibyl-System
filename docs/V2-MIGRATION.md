# V2 Migration: opencode 1.x plugin API → 2.x plugin API

Status: implemented at v2.0.0 (2026-11-12). Authority for API facts: the
@opencode/plugin@2.2.7 + @opencode/client@2.2.7 declaration files, re-verified
against opencode CLI 2.2.7 at implementation time; structural facts re-probed
live during a host-machine smoke run (see CHANGELOG entry).

## Goal

Keep every Sibyl law intact while the plugin platform moves from opencode 1.x
(`@opencode-ai/plugin`, `client.session.*` with `{data,error}` envelopes) to
opencode 2.x (`{id, setup(ctx)}` entry, `ctx.session` promise domain that
returns values directly and throws on error).

## Invariants restored / preserved

- EngineClient seam (`src/engine/index.ts`) is the single SDK boundary. All
  business logic (engine, council, swarm, tools cores, independence, salvage,
  transport retry, terminal rows, fail-closed tallies) consumes the seam and
  is UNCHANGED by this migration.
- Fail-closed voter tool-gate ("voters must not mutate", audit F1): V1 hid
  bash/edit/write from the voter prompt via a per-prompt tools map. V2 has no
  such prompt field, so the gate moves to `ctx.tool.hook("execute.before")`:
  any disallowed tool call in a Sibyl-gated session throws BEFORE execution.
  This is stronger, not weaker: V1 hid the tool from the list; V2 additionally
  hard-refuses any attempt to execute it. Recorded as a semantic change.
- Per-session persona system prompt: V1 sent it per prompt body; V2 injects it
  via the `ctx.session.hook("context")` transform (`system.push`), keyed by a
  per-session map updated at each seam prompt call. Follow-up turns (which
  carry no system text) clear the entry, matching V1's per-turn semantics.
- Directory is per-session and engine-authoritative: V2's ToolContext carries
  no `directory`, so tools resolve the calling session's `location.directory`
  through `ctx.session.get` (cached per session, never a closure capture).
  A session whose record cannot be read fails the tool loudly (fail-closed).
- LOUD disable path on invalid config (learnings #3): parseOptions failure
  logs to stderr and registers NOTHING (no tools, no hooks).
- `{data,error}` envelope discipline inside the seam: the V2 promise client
  throws; the adapter catches every call and re-envelopes so the engine's
  never-throw contract, salvage regex, and transport-retry classification
  keep operating on unchanged text channels.

## Prompt redistribution (V1 prompt body → V2 call sequence)

V1 `session.prompt({model, system, tools, parts})` has no single V2
equivalent. The adapter performs, in order:

1. gate map update for the session from `tools` (names mapped to `false`),
2. system map update/clear from `system` (consumed by the context hook),
3. `session.switchModel({model:{id,providerID}})`,
4. `session.prompt({sessionID, text})` — admission only (inbox ack),
5. `session.wait({sessionID})` — the blocking turn-to-idle call,
6. `session.context({sessionID})` — read the last assistant message and
   rebuild the V1-shaped `{info:{providerID,modelID,error}, parts}` return.

`session.context` also backs the seam `messages()` (salvage loop, anchor
verification, independence drafting-evidence reads). User messages map their
plain `text` field to a text part so the anchor check keeps reading human
bodies.

## Impact surface

- New: `src/v2/types.ts` (structural V2 types, zero runtime imports),
  `src/v2/adapter.ts` (seam bridge + session-state maps + directory resolver),
  `src/tools/define.ts` (`defineTool`: zod `StandardSchemaV1` input +
  `{content}` result wrapper + internalError catch-all).
- Rewritten: `src/index.ts` (entry becomes `{id:"sibyl-system", setup}`),
  7 tool builder wrappers (mechanical: `tool.schema.*` → `z.*`).
- Touched: `src/tools/shared.ts` (ToolDeps gains `resolveDirectory`).
- Unchanged: engine, council, swarm, exam, state, verdict, independence,
  lane, options, cli, all Execute cores and their tests.
- Zero new runtime dependencies (zod stays; `@opencode-ai/plugin` is dropped;
  V2 types are structural, provenance-anchored — same discipline as the seam).

## Rollback

`git revert` of the v2.0.0 commits restores the V1 plugin exactly; the V1 host
binary is archived in the owner machine's debug workspace, deliberately outside
this repository. No state-format change: RunStore files and terminal rows
are untouched by the migration.

## Known semantic deltas (accepted, named)

- Voter tool-gate enforcement point: tool-list hiding → execution refusal.
- The context hook cannot distinguish primary from title/compaction requests
  (no `kind` on the event), so a persona system part may ride a cosmetic
  title-generation request; it never crosses a session boundary.
- `session.wait` is the plugin-supported idle barrier; it is flagged
  deprecated on the RAW client but is the SessionDomain path exposed to
  plugins in 2.2.7. Watch item for the next platform minor.
- V1-era `e2e/*.mjs` and `spike/probe-plugin/` are historical evidence
  artifacts written against `@opencode-ai/sdk`; they are not executed by the
  test suite and are intentionally left as committed history.
