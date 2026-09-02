/**
 * MAGI Milestone-0 spike probe plugin — plain JS, no build, no local deps.
 *
 * Hypothesis under test: a STANDARD opencode plugin tool can drive child LLM
 * sessions to completion BY ITSELF via ctx.client.session.create +
 * ctx.client.session.prompt (per-request model override), synchronously
 * awaited INSIDE the tool execute(), in a headless `opencode run --auto`.
 *
 * Import pattern mirrors a live in-tree plugin server shipped under
 * ~/.config/opencode/plugins/:
 * bare `@opencode-ai/plugin` import, resolved by opencode's plugin loader.
 */
import { tool } from "@opencode-ai/plugin"

const PROVIDER_ID = "acme-provider"
const MODEL_ID = "acme-model-a"
const CHILD_TIMEOUT_MS = 240_000

function shortId() {
  return Math.random().toString(36).slice(2, 8)
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One council-member drive: create child session -> prompt it -> extract text. */
async function driveChild(ctx, marker) {
  const t0 = Date.now()
  const out = { marker, sessionID: null, ok: false, childText: "", latencyMs: 0, modelApplied: null }
  try {
    // Stage 1: session.create — SDK type SessionCreateData:
    //   { body?: { parentID?, title? }, query?: { directory? } }
    const created = await withTimeout(
      ctx.client.session.create({
        body: { title: `magi-spike ${marker}` },
        query: { directory: ctx.directory },
      }),
      CHILD_TIMEOUT_MS,
      "session.create",
    )
    if (created.error || !created.data?.id) {
      out.stage = "session.create"
      out.error = JSON.stringify(created.error ?? { note: "no data.id in response" })
      return out
    }
    out.sessionID = created.data.id

    // Stage 2: session.prompt (blocking) — SDK type SessionPromptData:
    //   { path: { id }, body?: { messageID?, model?: { providerID, modelID },
    //     agent?, noReply?, system?, tools?, parts: [...] }, query?: { directory? } }
    const prompted = await withTimeout(
      ctx.client.session.prompt({
        path: { id: out.sessionID },
        body: {
          model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
          parts: [
            {
              type: "text",
              text:
                `Reply with EXACTLY: PROBE-OK ${marker} — no tools, no extra words.`,
            },
          ],
        },
        query: { directory: ctx.directory },
      }),
      CHILD_TIMEOUT_MS,
      "session.prompt",
    )
    out.latencyMs = Date.now() - t0
    if (prompted.error || !prompted.data) {
      out.stage = "session.prompt"
      out.error = JSON.stringify(prompted.error ?? { note: "empty response" })
      return out
    }
    const info = prompted.data.info ?? {}
    const parts = prompted.data.parts ?? []
    out.modelApplied = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : null
    out.finishReason = info.finish ?? null
    out.infoError = info.error ?? null
    const text = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
    out.childText = text.slice(0, 300)
    out.markerEchoed = text.includes(`PROBE-OK ${marker}`)
    out.ok = out.markerEchoed && !info.error
    if (!out.ok && !out.error) {
      out.stage = "verify"
      out.error = out.infoError
        ? JSON.stringify(out.infoError)
        : "marker not echoed by child"
    }
    return out
  } catch (e) {
    out.latencyMs = Date.now() - t0
    out.stage = out.stage ?? "exception"
    out.error = String(e?.message ?? e)
    return out
  }
}

export default {
  id: "magi-spike-probe",
  server: async (ctx) => ({
    tool: {
      magi_probe: tool({
        description:
          "MAGI spike probe: drive child LLM sessions from inside this tool call. mode=single drives 1 child, mode=parallel drives 2 concurrently. Returns raw JSON evidence.",
        args: {
          subject: tool.schema.string().describe("Free-form subject for the probe"),
          mode: tool.schema
            .enum(["single", "parallel"])
            .describe("single = 1 child session, parallel = 2 concurrent child sessions"),
        },
        async execute(args) {
          const t0 = Date.now()
          try {
            const n = args.mode === "parallel" ? 2 : 1
            const markers = Array.from(
              { length: n },
              (_, i) => `M${i}-${args.subject.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "x"}-${shortId()}`,
            )
            const children = await Promise.all(markers.map((m) => driveChild(ctx, m)))
            const result = {
              ok: children.every((c) => c.ok),
              mode: args.mode,
              subject: args.subject,
              directory: ctx.directory,
              totalLatencyMs: Date.now() - t0,
              children,
            }
            return JSON.stringify(result, null, 2)
          } catch (e) {
            return JSON.stringify({
              ok: false,
              stage: "execute",
              error: String(e?.message ?? e),
            })
          }
        },
      }),
    },
  }),
}
