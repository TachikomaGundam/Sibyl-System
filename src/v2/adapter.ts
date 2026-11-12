// provenance: original clean-room Sibyl-System implementation, no external code copied.
//
// V2 seam bridge: maps the EngineClient contract (V1-shaped `{data,error}`
// envelopes, blocking prompt) onto the opencode 2.x promise SessionDomain
// (values returned directly, THROWN on error, inbox prompt + wait + context).
// The redistribution of the V1 prompt body is documented in
// docs/V2-MIGRATION.md "Prompt redistribution"; this file is its only
// implementation point. All engine law (salvage, transport retry, tool-gate
// semantics, never-throw) stays in src/engine and consumes THIS seam.

import type { EngineClient } from "../engine/index.ts";
import { errMessage } from "../util.ts";
import type { V2ContextMessage, V2SessionContextEvent, V2SessionDomain, V2ToolBeforeEvent } from "./types.ts";

/** Per-session plugin state the 2.x platform no longer carries per prompt.
 * - systems: persona system text injected via the session context hook,
 *   set/cleared at every seam prompt (V1 per-turn semantics).
 * - gates: disallowed tool names per session — enforced at execution time by
 *   the execute.before hook (fail-closed; audit F1 gate, V2 enforcement point).
 * - dirs: cached session directory (pure cache; misses re-read the engine).
 *
 * Growth bound: entries are pruned when the seam deletes a session. Sessions
 * removed outside this plugin (e.g. the reaper) leak only their small map
 * entry; NO eviction on purpose — silently dropping a live session's gate
 * would be fail-open, and MB-scaled maps beat that risk (docs/V2-MIGRATION.md). */
export type V2SessionState = {
  systems: Map<string, string>;
  gates: Map<string, Set<string>>;
  dirs: Map<string, string>;
};

export function createSessionState(): V2SessionState {
  return { systems: new Map(), gates: new Map(), dirs: new Map() };
}

export function clearSessionState(state: V2SessionState): void {
  state.systems.clear();
  state.gates.clear();
  state.dirs.clear();
}

/** execute.before hook callback: refuse any disallowed tool in a gated
 * session. Throwing here blocks execution BEFORE side effects (fail-closed).
 * Only sessions the Sibyl engine prompted are in the map — human/lead
 * sessions are never gated. */
export function gateToolEvent(state: V2SessionState) {
  return (event: V2ToolBeforeEvent): void => {
    const gate = state.gates.get(event.sessionID);
    if (gate !== undefined && gate.has(event.tool)) {
      throw new Error(
        `SIBYL: tool "${event.tool}" is disallowed for this seat (fail-closed voter/worker tool-gate, audit F1)`,
      );
    }
  };
}

/** session context hook callback: ride the persona system part on every model
 * request of the session's turn until the next seam prompt clears it. */
export function injectSessionSystem(state: V2SessionState) {
  return (event: V2SessionContextEvent): void => {
    const system = state.systems.get(event.sessionID);
    if (system !== undefined && system.length > 0) {
      event.system.push({ type: "text", text: system });
    }
  };
}

/** Directory resolver for tool contexts: V2 ToolContext carries no directory,
 * so it is read from the ENGINE's session record (location.directory) — the
 * same per-session authority V1 got from context.directory, never a closure.
 * A session whose record cannot be read throws: tools surface it as an
 * internal error rather than guessing a directory (fail-closed). */
export function makeDirectoryResolver(session: V2SessionDomain, state: V2SessionState) {
  return async (sessionID: string): Promise<string> => {
    const cached = state.dirs.get(sessionID);
    if (cached !== undefined) return cached;
    const record = await session.get({ sessionID });
    const directory = record.location?.directory;
    if (typeof directory !== "string" || directory.length === 0) {
      throw new Error(`sibyl: session ${sessionID} has no location.directory in the engine store`);
    }
    state.dirs.set(sessionID, directory);
    return directory;
  };
}

type SeamMessages = NonNullable<
  Awaited<ReturnType<NonNullable<EngineClient["session"]["messages"]>>>["data"]
>;
type SeamMessagePart = NonNullable<SeamMessages[number]["parts"]>[number];

/** Map 2.x context() messages onto the seam message shape. The salvage loop
 * needs info.role/time.completed/error; the anchor check needs USER text
 * bodies (SessionMessageUser.text is a plain string in 2.x); the independence
 * drafting-evidence read needs tool parts with name + input. */
export function mapContextMessages(messages: V2ContextMessage[]): SeamMessages {
  return messages.map((m) => {
    const parts: SeamMessagePart[] = [];
    if (m.type === "assistant") {
      for (const item of m.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push({ type: "text", text: item.text });
        } else if (item.type === "tool") {
          parts.push({
            type: "tool",
            ...(typeof item.name === "string" && { tool: item.name }),
            ...(item.state?.input !== undefined && { input: item.state.input }),
          });
        }
      }
    } else if (m.type === "user" && typeof m.text === "string") {
      parts.push({ type: "text", text: m.text });
    }
    const providerID = m.model?.providerID;
    const modelID = m.model?.id;
    return {
      info: {
        ...(typeof m.type === "string" && { role: m.type }),
        // V1 adapter law (W1 lineage): model identity + time + error ride the
        // ASSISTANT arm only; the user arm stays role-only.
        ...(m.type === "assistant" && {
          ...(typeof providerID === "string" && { providerID }),
          ...(typeof modelID === "string" && { modelID }),
          ...(m.time !== undefined && {
            time: {
              ...(typeof m.time.created === "number" && { created: m.time.created }),
              ...(typeof m.time.completed === "number" && { completed: m.time.completed }),
            },
          }),
          ...(m.error !== undefined && { error: m.error }),
        }),
      },
      parts,
    };
  });
}

/** Bridge EngineClient onto the 2.x promise SessionDomain. Every call keeps
 * the seam envelope contract: never throws, `{data?, error?}` only, so the
 * engine's salvage regex and transport-retry classification see the same
 * text channels they saw under V1. */
export function toEngineClientV2(session: V2SessionDomain, state: V2SessionState): EngineClient {
  return {
    session: {
      create: async ({ body, query }) => {
        try {
          const created = await session.create({
            title: body.title,
            ...(body.parentID !== undefined && body.parentID.length > 0 && { parentID: body.parentID }),
            location: { directory: query.directory },
          });
          return { data: { id: created.id } };
        } catch (err) {
          return { error: err };
        }
      },

      get: async ({ path }) => {
        try {
          const record = await session.get({ sessionID: path.id });
          return {
            data: {
              id: record.id,
              ...(record.parentID !== undefined && { parentID: record.parentID }),
            },
          };
        } catch (err) {
          return { error: err };
        }
      },

      delete: async ({ path }) => {
        try {
          await session.remove({ sessionID: path.id });
          state.systems.delete(path.id);
          state.gates.delete(path.id);
          state.dirs.delete(path.id);
          return {};
        } catch (err) {
          return { error: err };
        }
      },

      messages: async ({ path }) => {
        try {
          const messages = await session.context({ sessionID: path.id });
          return { data: mapContextMessages(messages) };
        } catch (err) {
          return { error: err };
        }
      },

      prompt: async ({ path, body }) => {
        const sessionID = path.id;
        // Gate + system redistribution happens even when a later call throws:
        // the maps describe this session's turn law, not one RPC's success.
        state.gates.set(
          sessionID,
          new Set(
            Object.entries(body.tools ?? {})
              .filter(([, allowed]) => allowed === false)
              .map(([name]) => name),
          ),
        );
        if (typeof body.system === "string" && body.system.length > 0) {
          state.systems.set(sessionID, body.system);
        } else {
          state.systems.delete(sessionID);
        }
        try {
          // Empty model ref (unconfigured modelPool default) must NOT be pushed
          // through switchModel: 2.2.7 persists the literal empty ref and the
          // turn dies with provider.no-route "Model unavailable: /" (live probe
          // 2026-11-12). V1 treated an empty prompt-body model as "engine
          // default"; skipping the switch restores that parity — the assistant
          // message then honestly reports the model the engine actually used.
          if (body.model.providerID.length > 0 && body.model.modelID.length > 0) {
            await session.switchModel({
              sessionID,
              model: { id: body.model.modelID, providerID: body.model.providerID },
            });
          }
          await session.prompt({
            sessionID,
            text: body.parts.map((part) => part.text).join("\n"),
          });
          await session.wait({ sessionID });
          const messages = await session.context({ sessionID });
          const last = [...messages].reverse().find((m) => m.type === "assistant");
          if (last === undefined) {
            // 2.x records a turn's cause of death on the trailing idle row
            // (SessionMessageIdle {outcome, error?}) — without surfacing it a
            // provider-side failure (e.g. provider.no-route from an empty
            // model ref) degrades into an opaque "no assistant message".
            const idle = [...messages].reverse().find((m) => m.type === "idle");
            const outcome = typeof idle?.outcome === "string" ? ` (outcome=${idle.outcome})` : "";
            const cause = idle?.error !== undefined ? `: ${errMessage(idle.error)}` : "";
            return {
              error: new Error(`session.prompt: session ${sessionID} reached idle without an assistant message${outcome}${cause}`),
            };
          }
          const mapped = mapContextMessages([last])[0] ?? { info: {}, parts: [] };
          return {
            data: {
              info: {
                ...(mapped.info?.providerID !== undefined && { providerID: mapped.info.providerID }),
                ...(mapped.info?.modelID !== undefined && { modelID: mapped.info.modelID }),
                ...(mapped.info?.error !== undefined && { error: mapped.info.error }),
              },
              // V1 prompt envelope parity, tightened: text parts only (V1 kept
              // inert {type:"tool"} stubs here; every consumer of the prompt
              // return reads text — full tool detail is carried by seam
              // messages(), not by the prompt return).
              parts: (mapped.parts ?? [])
                .filter((p) => p.type === "text" && typeof p.text === "string")
                .map((p) => ({ type: p.type, text: p.text as string })),
            },
          };
        } catch (err) {
          return { error: err };
        }
      },
    },
  };
}
