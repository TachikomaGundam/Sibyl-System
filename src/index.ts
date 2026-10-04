// provenance: original clean-room Sibyl-System implementation (plan task 8 — plugin
// entry), no swarm code copied.
//
// The SIBYL plugin surface: seven tools registered through the SDK tool()
// helper — sibyl_consult (fail-closed 3-persona council verdict), sibyl_swarm
// (thin driver of the PLAN→MINT→DISPATCH→AGGREGATE pipeline), sibyl_status
// (read-only run store + chamber ledger view), sibyl_review (v1.1 general
// democratic-centralism chamber: any review need, one voice at terminal), and
// the read-only audit primitives sibyl_anchor_check / sibyl_time_probe /
// sibyl_attribute.
// Zero external fleet-orchestration coupling by design.
//
// Entry contract (spike/GO.md, learnings #3): a plugin that throws on load
// fails SILENTLY inside the host — so config errors are reported LOUDLY via
// console.error and the plugin returns an empty Hooks object instead. The one
// RunStore and the one EngineClient adapter are constructed here and shared by
// all seven tools (the store's RMW mutex is per-instance). Tools receive the
// per-session directory through their execute context, never a closure.

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import type { EngineClient } from "./engine/index.ts";
import { parseOptions } from "./options.ts";
import { RunStore } from "./state/index.ts";
import { buildConsultTool } from "./tools/consult.ts";
import { buildReviewTool } from "./tools/review.ts";
import { buildAnchorTool } from "./tools/anchor.ts";
import { buildAttributeTool, buildTimeProbeTool } from "./tools/probes.ts";
import { buildStatusTool } from "./tools/status.ts";
import { buildSwarmTool } from "./tools/swarm.ts";
import type { ToolDeps } from "./tools/shared.ts";

/**
 * Adapt the real SDK client to the engine's structural EngineClient seam.
 * The SDK returns `{data, error, request, response}` unions whose inactive
 * arm carries REQUIRED `data: undefined` / `error: undefined` keys; under
 * exactOptionalPropertyTypes those are NOT assignable to EngineClient's
 * optional-bag returns (proved by .omo/evidence/t8/assign-probe.ts), so every
 * call is normalized through conditional spreads here. Request params need no
 * translation: v1.15.13 types.gen prompt path is `{ id: string }`, matching
 * the runtime (learnings #1).
 */
export function toEngineClient(sdk: PluginInput["client"]): EngineClient {
  return {
    session: {
      async delete(args: { path: { id: string } }) {
        return await sdk.session.delete(args as never);
      },
      async create(args) {
        const r = await sdk.session.create({
          body: {
            title: args.body.title,
            ...(args.body.parentID !== undefined && { parentID: args.body.parentID }),
          },
          query: { directory: args.query.directory },
        });
        return {
          ...(r.data !== undefined && { data: { id: r.data.id } }),
          ...(r.error !== undefined && { error: r.error }),
        };
      },
      async prompt(args) {
        const r = await sdk.session.prompt({
          path: { id: args.path.id },
          body: {
            model: { providerID: args.body.model.providerID, modelID: args.body.model.modelID },
            ...(args.body.agent !== undefined && { agent: args.body.agent }),
            ...(args.body.system !== undefined && { system: args.body.system }),
            tools: args.body.tools,
            parts: args.body.parts.map((p) => ({ type: "text" as const, text: p.text })),
          },
          query: { directory: args.query.directory },
        });
        return {
          ...(r.data !== undefined && {
            data: {
              ...(r.data.info !== undefined && {
                info: {
                  ...(r.data.info.providerID !== undefined && { providerID: r.data.info.providerID }),
                  ...(r.data.info.modelID !== undefined && { modelID: r.data.info.modelID }),
                  ...(r.data.info.error !== undefined && { error: r.data.info.error }),
                },
              }),
              ...(r.data.parts !== undefined && {
                parts: r.data.parts.map((p) => ({
                  type: p.type,
                  ...("text" in p && p.text !== undefined && { text: p.text }),
                })),
              }),
            },
          }),
          ...(r.error !== undefined && { error: r.error }),
        };
      },
      async messages(args) {
        const r = await sdk.session.messages({
          path: { id: args.path.id },
          query: { directory: args.query.directory },
        });
        return {
          ...(r.data !== undefined && {
            data: r.data.map((m) => ({
              info: {
                ...(m.info.role !== undefined && { role: m.info.role }),
                ...(m.info.role === "assistant" && {
                  ...(m.info.providerID !== undefined && { providerID: m.info.providerID }),
                  ...(m.info.modelID !== undefined && { modelID: m.info.modelID }),
                  ...(m.info.time !== undefined && {
                    time: { ...(m.info.time.completed !== undefined && { completed: m.info.time.completed }) },
                  }),
                  ...(m.info.error !== undefined && { error: m.info.error }),
                }),
              },
              parts: m.parts.map((p) => ({
                type: p.type,
                ...("text" in p && p.text !== undefined && { text: p.text }),
              })),
            })),
          }),
          ...(r.error !== undefined && { error: r.error }),
        };
      },
    },
  };
}

export default async function SibylPlugin(
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> {
  const parsed = parseOptions(options);
  if (!parsed.ok) {
    // Plugin-load failures are invisible in the host: scream instead of throwing.
    for (const line of parsed.errors) {
      console.error(`[sibyl] config error: ${line}`);
    }
    console.error("[sibyl] SIBYL plugin DISABLED — fix options (no sibyl_* tools registered)");
    return {};
  }

  const deps: ToolDeps = {
    client: toEngineClient(input.client),
    store: new RunStore(),
    options: parsed.options,
  };
  return {
    tool: {
      sibyl_consult: buildConsultTool(deps),
      sibyl_swarm: buildSwarmTool(deps),
      sibyl_status: buildStatusTool(deps),
      sibyl_review: buildReviewTool(deps),
      sibyl_anchor_check: buildAnchorTool(deps),
      sibyl_time_probe: buildTimeProbeTool(deps),
      sibyl_attribute: buildAttributeTool(deps),
    },
  };
}
