// provenance: original clean-room Sibyl-System implementation, no external code copied.
//
// Structural TypeScript mirror of the opencode 2.x plugin promise API surface
// Sibyl actually touches. Shape facts were read off the installed
// @opencode/plugin@2.2.7 + @opencode/client@2.2.7 declaration files
// (promise/plugin.d.ts, promise/session.d.ts, promise/tool.d.ts,
// promise/registration.d.ts, promise/generated/types.d.ts) during the 2.x
// migration and re-probed live against CLI 2.2.7 (docs/V2-MIGRATION.md).
//
// Why structural types instead of the SDK package: the same discipline as the
// EngineClient seam — the plugin keeps ZERO runtime dependency on the host and
// survives SDK repackings; the host accepts a plain {id, setup} default export
// (a local seat plugin runs this shape on 2.2.7). Widening/renaming on the
// host side surfaces as adapter errors at runtime, which the {data,error}
// envelope and the LOUD-disable path already channel honestly.

/** System-prompt part as accepted by the session context hook (2.2.7). */
export type V2SystemPart = { type: "text"; text: string };

/** ctx.session.hook("context", …) event — mutable request snapshot. */
export type V2SessionContextEvent = {
  sessionID: string;
  system: V2SystemPart[];
};

/** ctx.tool.hook("execute.before", …) event (2.2.7 ToolHooks). */
export type V2ToolBeforeEvent = {
  tool: string;
  sessionID: string;
  input: unknown;
};

/** Minimal message shapes the seam reads out of session.context().
 * Field facts: SessionMessageAssistant {type:"assistant", time:{created,completed?},
 * model:{id,providerID}, content:[{type:"text",text}|{type:"tool",name,state:{input}}], error?}
 * and SessionMessageUser {type:"user", text, time:{created}}. */
export type V2ContextMessage = {
  id?: string;
  type?: string;
  text?: string;
  time?: { created?: number; completed?: number };
  model?: { id?: string; providerID?: string };
  error?: unknown;
  /** SessionMessageIdle {type:"idle", outcome, error?} — the engine's own
   * terminal row for a turn; carries the cause of death when no assistant
   * message was ever produced (2.2.7 live probe: provider.no-route lands here). */
  outcome?: string;
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    state?: { input?: Record<string, unknown> };
  }>;
};

/** The slice of the 2.x promise SessionDomain the adapter uses. */
export type V2SessionDomain = {
  create(input: {
    title?: string;
    parentID?: string;
    location?: { directory: string };
  }): Promise<{ id: string; parentID?: string; location?: { directory?: string } }>;
  get(input: { sessionID: string }): Promise<{
    id: string;
    parentID?: string;
    location?: { directory?: string };
  }>;
  remove(input: { sessionID: string }): Promise<unknown>;
  switchModel(input: { sessionID: string; model: { id: string; providerID: string } }): Promise<unknown>;
  prompt(input: { sessionID: string; text: string }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<V2ContextMessage[]>;
  update(input: { sessionID: string } & Record<string, unknown>): Promise<unknown>;
  hook<Name extends "context">(
    name: Name,
    callback: (event: Name extends "context" ? V2SessionContextEvent : never) => Promise<void> | void,
  ): Promise<{ dispose: () => Promise<void> }>;
};

/** ToolContext as handed to editor-registered tools (2.2.7 promise ToolContext). */
export type V2ToolContext = {
  sessionID: string;
  signal: AbortSignal;
};

/** Tool result (2.2.7 Tool.Result — Sibyl returns {content: string}). */
export type V2ToolResult = { content: string };

/** ToolEditor.add payload; `input` is any StandardSchemaV1 (zod v4 qualifies).
 * Sibyl's defineTool wrapper validates the raw input with the same zod schema,
 * so the execute signature widens to `unknown` here. */
export type V2ToolInfo = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: V2ToolContext) => Promise<V2ToolResult>;
};

export type V2ToolEditor = {
  add(tool: V2ToolInfo): void;
};

export type V2ToolDomain = {
  transform(callback: (editor: V2ToolEditor) => void): Promise<{ dispose: () => Promise<void> }>;
  hook(
    name: "execute.before",
    callback: (event: V2ToolBeforeEvent) => Promise<void> | void,
  ): Promise<{ dispose: () => Promise<void> }>;
};

/** The slice of the plugin Context (setup argument) Sibyl uses. */
export type V2Context = {
  location?: { directory?: string };
  options: unknown;
  session: V2SessionDomain;
  tool: V2ToolDomain;
};

/** The 2.x plugin contract: default export {id, setup}; setup returns cleanup. */
export type V2Plugin = {
  id: string;
  setup: (ctx: V2Context) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
};
