// provenance: g12b-3 human-anchor validator primitive (plan: Abathur loop/proposals/
// g12b-instruments-draft.md), original clean-room implementation.
//
// sibyl_anchor_check — mechanically re-verifies a "human anchor" claim (a message
// the owner says they sent: order/approval/ratification) against the engine's own
// session store, instead of trusting a transcribed string inside a ledger. The
// anchor verdict is a 4-state closed enum: MATCH / MISMATCH / ABSENT / ERROR —
// selecting among them without evidence is forbidden (sibling of L-BLIND-AUDIT's
// exit taxonomy). The receipt carries a hash of the canonical VIEW that was read,
// so "what did the validator see at check time" is itself re-computable, and a
// later re-run against a mutated store shows up as a view-hash difference.
// This is the read primitive; ledgering the receipt stays with the caller.

import { tool } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";

import { internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";

export const ANCHOR_TOOL_NAME = "sibyl_anchor_check";

export type AnchorVerdict = "MATCH" | "MISMATCH" | "ABSENT" | "ERROR";

export type MessageRow = {
  info?: { role?: string | undefined } & Record<string, unknown> | undefined;
  parts?: { type: string; text?: string | undefined }[] | undefined;
};

/** Deterministic serialization of the read view: only the fields the verdict
 * depends on, in list order. Key insertion order cannot vary what we emit. */
export function canonicalView(rows: MessageRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      role: r.info?.role ?? null,
      parts: (r.parts ?? []).map((p) => ({ t: p.type, x: p.text ?? "" })),
    })),
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Extract the anchor body text: concat of text-type parts, "\n"-joined. */
export function anchorText(row: MessageRow): string {
  return (row.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

/** Pure decision core — closed 4-state, no strings to misparse. */
export function decide(
  row: MessageRow | undefined,
  expected: string | undefined,
): { verdict: AnchorVerdict; text: string } {
  if (row === undefined) return { verdict: "ABSENT", text: "" };
  if (expected === undefined) return { verdict: "ABSENT", text: anchorText(row) }; // no claim to check
  const text = anchorText(row);
  const normalized = expected.trim().toLowerCase();
  return { verdict: sha256(text) === normalized ? "MATCH" : "MISMATCH", text };
}

export async function anchorExecute(
  deps: ToolDeps,
  args: { sessionId: string; index?: number | undefined; expectSha256?: string | undefined; label?: string | undefined },
  context: ToolContextLike,
): Promise<string> {
  const messages = deps.client.session.messages;
  if (!messages) {
    return "SIBYL ANCHOR: ERROR — engine client exposes no session.messages seam (cannot answer; not a reject).";
  }
  if (args.expectSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(args.expectSha256)) {
    return "SIBYL ANCHOR: ERROR — expectSha256 must be 64 hex chars (a malformed claim is not a MISMATCH verdict).";
  }
  let rows: MessageRow[];
  try {
    const res = await messages.call(deps.client.session, {
      path: { id: args.sessionId },
      query: { directory: context.directory },
    });
    if (res.error !== undefined) {
      return `SIBYL ANCHOR: ERROR — engine refused the read (${JSON.stringify(res.error).slice(0, 200)}).`;
    }
    rows = res.data ?? [];
  } catch (e) {
    return internalError("sibyl_anchor_check", e);
  }
  const idx = args.index ?? -1;
  const row = idx >= 0 ? rows[idx] : rows[rows.length + idx];
  const claim = args.expectSha256 !== undefined;
  const { verdict, text } = claim ? decide(row, args.expectSha256) : { verdict: "ABSENT" as AnchorVerdict, text: row ? anchorText(row) : "" };
  const finalVerdict: AnchorVerdict = !claim ? (row === undefined ? "ABSENT" : "ERROR") : verdict;
  // Without a claim there is nothing to verify — honest cannot-answer, not a dump.
  const receipt = [
    `SIBYL ANCHOR ${finalVerdict}`,
    `session=${args.sessionId} index=${idx} messages=${rows.length} role=${row?.info?.role ?? "-"}`,
    args.label !== undefined ? `label=${args.label}` : "",
    `anchor_sha256=${row === undefined ? "-" : sha256(anchorText(row))}`,
    `claim_sha256=${args.expectSha256 ?? "-"}`,
    `view_sha256=${sha256(canonicalView(rows))}`,
    `body_len=${text.length}`,
    claim ? "" : "note: no expectSha256 supplied — a verdict requires the claim; nothing is asserted about content.",
  ].filter((l) => l !== "").join("\n");
  return receipt;
}

export function buildAnchorTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL anchor check (g12b-3 primitive): verify a claimed human message (order/approval) " +
      "against the engine session store — closed verdict MATCH/MISMATCH/ABSENT/ERROR plus a " +
      "view-hash receipt so the read itself is re-computable. Read-only; persists nothing.",
    args: {
      sessionId: tool.schema.string().min(1).describe("Engine session id that allegedly contains the human message."),
      index: tool.schema.number().int().optional().describe("Message ordinal in the session (0-based; negative counts from the end). Default: last message."),
      expectSha256: tool.schema.string().min(64).max(64).optional().describe("Claimed sha256 (hex) of the anchor body text; omitting it yields a non-verdict."),
      label: tool.schema.string().min(1).optional().describe("Free-form label echoed into the receipt (e.g. the order being ratified)."),
    },
    execute: async (args, context) => anchorExecute(deps, args, context),
  });
}
