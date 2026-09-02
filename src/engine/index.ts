// provenance: original clean-room implementation per spike/GO.md contract, no external code copied
//
// SIBYL engine primitive: the single function every higher layer (council,
// swarm, tools) calls. Drives one child LLM session to completion — create +
// prompt — through an EngineClient and ALWAYS returns a structured
// PersonaRunResult; this function never throws. (spike/GO.md error-handling
// notes: a throw out of a tool execute() would surface as a tool error to the
// lead, losing structured evidence; the SDK client itself never throws on
// HTTP errors, it resolves {data, error}).
//
// Contract implemented verbatim from spike/GO.md "FINAL working API shape" +
// "Recommended engine contract":
//   - session.create({ body: { title }, query: { directory } }) — parentID
//     omitted (spike gotcha 3: top-level children prompt fine)
//   - session.prompt({ path: { id }, body: { model, agent, system, tools,
//     parts }, query: { directory } }) — parts REQUIRED and non-empty
//   - tools = every disallowedTool name mapped to false (default
//     ["bash","edit","write"] — voters must not mutate)
//   - text = data.parts.filter(p => p.type === "text").map(p => p.text).join("")
//   - modelApplied = `${data.info.providerID}/${data.info.modelID}`
//   - child LLM failure surfaces as data.info.error — check BOTH prompted.error
//     and prompted.data.info.error
//   - per-stage Promise.race timeout guard (probe server.js:23-31 pattern,
//     clearTimeout in finally); the total budget is split: create gets the
//     full budget, prompt gets the remaining time (GO.md `remaining(...)`).
//
// Concurrency: no module-level mutable state — safe for the council's
// `Promise.all(personas.map(runPersona))` fan-out.

export type PersonaRunResult = {
  text: string;
  ok: boolean;
  latencyMs: number;
  sessionID: string;
  modelApplied: string | null;
  /** Present only on failure — which stage produced the failure. */
  stage?: string;
  /** Present only on failure — human-readable description. */
  error?: string;
};

/**
 * Minimal structural client interface — the single seam between the engine
 * and the opencode SDK.
 *
 * Deliberately typed as the option bags shown in spike/GO.md's FINAL working
 * API shape, NOT the generated SDK types (types.gen.d.ts names the prompt
 * path param `sessionID`; at runtime it is `{ id }` — learnings #1 — so the
 * SDK's own types would mislead a mock). BOTH the real `ctx.client` and any
 * test mock satisfy it structurally, with no `as any` anywhere:
 *   - parameters are the narrow contract bags: the real client accepts them
 *     (its params are wider optional bags, so ours are assignable), and a
 *     mock satisfies them trivially.
 *   - returns are `{ data?, error? }` shaped: the SDK resolves
 *     `{ data, error, response }` and never throws; `data` is typed to the
 *     few fields this module reads, `error` stays `unknown` (it is described
 *     via describeError, never re-typed).
 */
export type EngineClient = {
  session: {
    create(args: {
      body: { title: string };
      query: { directory: string };
    }): Promise<{ data?: { id?: string }; error?: unknown }>;
    prompt(args: {
      path: { id: string };
      body: {
        model: { providerID: string; modelID: string };
        agent?: string;
        system?: string;
        tools: Record<string, boolean>;
        parts: { type: "text"; text: string }[];
      };
      query: { directory: string };
    }): Promise<{
      data?: {
        info?: { providerID?: string; modelID?: string; error?: unknown };
        parts?: { type: string; text?: string }[];
      };
      error?: unknown;
    }>;
  };
};

export type RunPersonaOptions = {
  client: EngineClient;
  directory: string;
  persona: { agent?: string; system?: string; disallowedTools?: string[] };
  model: { providerID: string; modelID: string };
  inputText: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 240_000;
/** Single source of truth for the voter/worker tool-gate (audit F1): every
 * name mapped to false in a prompt body's `tools` — exported so the tools
 * layer's follow-up turns (runInSession) apply the identical gate. */
export const DEFAULT_DISALLOWED_TOOLS = ["bash", "edit", "write"];

/**
 * Promise.race guard with the timer cleared in finally (probe server.js:23-31).
 * On expiry the race rejects with an Error whose message contains "timeout",
 * which the caller maps to a structured {ok:false, stage, error} result.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Render an unknown error value as a stable string for the structured result. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    const json = JSON.stringify(e);
    return json === undefined ? String(e) : json;
  } catch {
    return String(e);
  }
}

/** Drive one child session; never throws, always returns a structured result. */
export async function runPersona(opts: RunPersonaOptions): Promise<PersonaRunResult> {
  const { client, directory, persona, model, inputText } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  // Stage attribution for failures; local to this invocation (concurrency-safe).
  let stage: "create" | "prompt" | "exception" = "exception";

  const fail = (error: string): PersonaRunResult => ({
    text: "",
    ok: false,
    latencyMs: Date.now() - t0,
    sessionID: "",
    modelApplied: null,
    stage,
    error,
  });

  try {
    // Stage 1: session.create — never throws; check .error / missing .data.id.
    stage = "create";
    const created = await withTimeout(
      client.session.create({
        body: { title: `sibyl:${persona.agent ?? "persona"}` },
        query: { directory },
      }),
      timeoutMs,
      "session.create",
    );
    if (created.error) return fail(describeError(created.error));
    const sessionID = created.data?.id;
    if (!sessionID) return fail("session.create: response missing data.id");

    // Stage 2: session.prompt (blocking full reply) — budget is what remains.
    stage = "prompt";
    const remainingMs = timeoutMs - (Date.now() - t0);
    const tools = Object.fromEntries(
      (persona.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS).map((name) => [name, false]),
    );
    const prompted = await withTimeout(
      client.session.prompt({
        path: { id: sessionID },
        body: {
          model,
          ...(persona.agent !== undefined && { agent: persona.agent }),
          ...(persona.system !== undefined && { system: persona.system }),
          tools,
          parts: [{ type: "text", text: inputText }],
        },
        query: { directory },
      }),
      remainingMs,
      "session.prompt",
    );
    if (prompted.error) return fail(describeError(prompted.error));
    if (!prompted.data) return fail("session.prompt: response missing data payload");
    const info = prompted.data.info;
    // Child LLM failure surfaces as info.error — check both failure channels.
    if (info?.error) return fail(describeError(info.error));
    const modelApplied =
      info?.providerID && info?.modelID ? `${info.providerID}/${info.modelID}` : null;
    const text = (prompted.data.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    return { text, ok: true, latencyMs: Date.now() - t0, sessionID, modelApplied };
  } catch (e) {
    // Any unexpected throw (timeout rejection, broken client) is captured here:
    // timeouts carry their stage ("create" | "prompt") via the stage tracker.
    return fail(e instanceof Error ? e.message : describeError(e));
  }
}