// provenance: original clean-room Sibyl-System implementation, no external code copied.
//
// defineTool — the V2 replacement for the V1 SDK `tool()` helper. It binds a
// tool's zod argument shape into the opencode 2.x ToolEditor.add payload:
//   - `input` receives the zod object directly: zod v4 implements
//     StandardSchemaV1, which 2.x accepts as Tool.ValueSchema (verified against
//     @opencode/client@2.2.7 promise/tool.d.ts + docs/V2-MIGRATION.md);
//   - `execute` re-validates the raw input with the same schema (defense in
//     depth), resolves the CALLING SESSION's directory through the engine
//     (V2 ToolContext has no directory — the per-session discipline of
//     ToolContextLike survives unchanged), adapts signal→abort, and returns
//     `{content}` results;
//   - every throw becomes an internalError string, preserving V1's contract
//     that a Sibyl tool never surfaces a raw exception to the lead.

import { z } from "zod";

import { internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";
import type { V2ToolInfo } from "../v2/types.ts";

export function defineTool<Shape extends z.ZodRawShape>(
  deps: ToolDeps,
  def: {
    name: string;
    description: string;
    args: Shape;
    core: (args: z.infer<z.ZodObject<Shape>>, context: ToolContextLike) => Promise<string>;
  },
): V2ToolInfo {
  const schema = z.object(def.args);
  return {
    name: def.name,
    description: def.description,
    input: schema,
    execute: async (rawInput: unknown, context) => {
      try {
        const args = schema.parse(rawInput) as z.infer<z.ZodObject<Shape>>;
        const directory = await deps.resolveDirectory(context.sessionID);
        const like: ToolContextLike = {
          directory,
          abort: context.signal,
          sessionID: context.sessionID,
        };
        return { content: await def.core(args, like) };
      } catch (err) {
        return { content: internalError(def.name, err) };
      }
    },
  };
}
