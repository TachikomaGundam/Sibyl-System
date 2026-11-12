// provenance: original clean-room Sibyl-System implementation (plan task 8 — plugin
// entry), no swarm code copied.
//
// The SIBYL plugin surface for opencode 2.x: eight tools registered through
// ctx.tool.transform — sibyl_consult (fail-closed 3-persona council verdict),
// sibyl_audit (blind fresh-convener audit), sibyl_swarm (thin driver of the
// PLAN→MINT→DISPATCH→AGGREGATE pipeline), sibyl_status (read-only run store +
// chamber ledger view), sibyl_review (v1.1 general democratic-centralism
// chamber: any review need, one voice at terminal), and the read-only audit
// primitives sibyl_anchor_check / sibyl_time_probe / sibyl_attribute.
// Zero external fleet-orchestration coupling by design; zero runtime
// dependency on the opencode SDK (structural types in src/v2/types.ts).
//
// Entry contract (spike/GO.md learnings #3, re-anchored for 2.x): a plugin
// that throws on load fails SILENTLY inside the host — so config errors are
// reported LOUDLY via console.error and setup registers NOTHING instead. The
// one RunStore, the one EngineClient adapter, and the one session-state map
// set are constructed here and shared by all tools (the store's RMW mutex is
// per-instance). Tools receive the per-session directory resolved from the
// engine's session record, never a closure.
//
// V2 platform wiring (docs/V2-MIGRATION.md): the persona system prompt rides
// the session "context" hook; the voter/worker tool-gate rides the
// "execute.before" tool hook (throw = refusal before side effects).

import { parseOptions } from "./options.ts";
import { RunStore } from "./state/index.ts";
import { buildConsultTool } from "./tools/consult.ts";
import { buildReviewTool } from "./tools/review.ts";
import { buildAnchorTool } from "./tools/anchor.ts";
import { buildAuditTool } from "./tools/audit.ts";
import { buildAttributeTool, buildTimeProbeTool } from "./tools/probes.ts";
import { buildStatusTool } from "./tools/status.ts";
import { buildSwarmTool } from "./tools/swarm.ts";
import type { ToolDeps } from "./tools/shared.ts";
import type { V2Plugin, V2ToolInfo } from "./v2/types.ts";
import {
  clearSessionState,
  createSessionState,
  gateToolEvent,
  injectSessionSystem,
  makeDirectoryResolver,
  toEngineClientV2,
} from "./v2/adapter.ts";

export { toEngineClientV2, createSessionState, clearSessionState } from "./v2/adapter.ts";

/** All tools Sibyl registers, in stable order (tested as an exact set). */
export function buildSibylTools(deps: ToolDeps): V2ToolInfo[] {
  return [
    buildConsultTool(deps),
    buildAuditTool(deps),
    buildSwarmTool(deps),
    buildStatusTool(deps),
    buildReviewTool(deps),
    buildAnchorTool(deps),
    buildTimeProbeTool(deps),
    buildAttributeTool(deps),
  ];
}

export const SIBYL_PLUGIN_ID = "sibyl-system";

const SibylPlugin: V2Plugin = {
  id: SIBYL_PLUGIN_ID,
  async setup(ctx) {
    const parsed = parseOptions(ctx.options);
    if (!parsed.ok) {
      // Plugin-load failures are invisible in the host: scream instead of throwing.
      for (const line of parsed.errors) {
        console.error(`[sibyl] config error: ${line}`);
      }
      console.error("[sibyl] SIBYL plugin DISABLED — fix options (no sibyl_* tools registered)");
      return;
    }

    const state = createSessionState();
    const deps: ToolDeps = {
      client: toEngineClientV2(ctx.session, state),
      store: new RunStore(),
      options: parsed.options,
      resolveDirectory: makeDirectoryResolver(ctx.session, state),
    };
    const tools = buildSibylTools(deps);

    // Registration is a pure replay over the fresh editor (transform
    // callbacks must be sync + cheap + replayable per the 2.x contract).
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
    await ctx.tool.hook("execute.before", gateToolEvent(state));
    await ctx.session.hook("context", injectSessionSystem(state));

    return () => {
      clearSessionState(state);
    };
  },
};

export default SibylPlugin;
