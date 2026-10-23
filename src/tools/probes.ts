// provenance: g12b-8 remote time-source probe + g12b-4 ref-move attribution
// comparator (plan: Abathur loop/proposals/g12b-instruments-draft.md), clean-room.
//
// design discipline shared by both probes:
//  - PURE cores, injected I/O (fetch / parsed inputs) so vitest never touches network or git;
//  - closed verdict enums; missing data is never read as consent (fail-closed);
//  - independence is mechanical: two sources signed/owned by the SAME owner/dept
//    are ONE source (the double-mirror-of-one-master attack).
//
// v1.5.0 input law (queue §3.1 of HANDOFF-SIBYL-20261023.md): caller-supplied JSON
// is NEVER trusted straight out of JSON.parse — every array goes through a shape
// validator with a named, field-pathed rejection before any predicate reads it.
// The time probe additionally never egresses toward internal address space:
// classifyEgress is a pure, offline gate over the URL's literal shape (see its
// named limitation in SECURITY.md — hostname-to-internal DNS answers are not
// filtered because the fetch API cannot pin a connection to a pre-verified IP).

import { tool } from "@opencode-ai/plugin";
import { internalError } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";
import { errMessage } from "../util.ts";

// ── time probe ───────────────────────────────────────────────────────────────

export type TimeSource = { readonly url: string; readonly ownerDept: string };

export type ProbeReceipt = {
  readonly url: string;
  readonly ownerDept: string;
  readonly ok: boolean;
  readonly epochMs?: number | undefined;
  readonly error?: string | undefined;
};

export const DEFAULT_TIME_POOL: readonly TimeSource[] = [
  { url: "https://www.cloudflare.com", ownerDept: "cloudflare" },
  { url: "https://www.google.com", ownerDept: "google" },
  { url: "https://www.mozilla.org", ownerDept: "mozilla" },
];

/** Upper bounds on caller-supplied arrays: the probes are verification
 * instruments, not batch processors — an oversized list is a misuse (or an
 * attempt to pin the host), refused by name, never silently truncated. */
export const MAX_TIME_SOURCES = 16;
export const MAX_INPUT_ITEMS = 4096;

/** Parse HTTP-date Date header; reject everything else (no silent NaN). */
export function parseHttpDate(value: string | null): number | undefined {
  if (value === null) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export async function probeTimes(
  sources: readonly TimeSource[],
  fetchImpl: typeof fetch,
  timeoutMs = 8000,
): Promise<ProbeReceipt[]> {
  return await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await fetchImpl(s.url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        const ms = parseHttpDate(res.headers.get("date"));
        return ms === undefined
          ? { url: s.url, ownerDept: s.ownerDept, ok: false, error: "no-parseable-date-header" }
          : { url: s.url, ownerDept: s.ownerDept, ok: true, epochMs: ms };
      } catch (e) {
        return { url: s.url, ownerDept: s.ownerDept, ok: false, error: String(e).slice(0, 120) };
      }
    }),
  );
}

export type Consensus = {
  readonly verdict: "SYNCED" | "DRIFT" | "INSUFFICIENT-SOURCES";
  readonly usedUrls: readonly string[];
  readonly spreadMs: number;
  readonly localOffsetMs: number;
};

/** Consensus over >=2 DISTINCT ownerDepts; same-owner pairs collapse to one
 * source on purpose. tolerance: per-hop network slop accepted (default 5 min —
 * HTTP Date has second granularity but proxies add lag; tighten per contract). */
export function consensus(receipts: readonly ProbeReceipt[], localMs: number, toleranceMs = 300_000): Consensus {
  const ok = receipts.filter((r) => r.ok && r.epochMs !== undefined);
  const byDept = new Map<string, ProbeReceipt>();
  for (const r of ok) if (!byDept.has(r.ownerDept)) byDept.set(r.ownerDept, r);
  const used = [...byDept.values()];
  if (used.length < 2) {
    return { verdict: "INSUFFICIENT-SOURCES", usedUrls: used.map((u) => u.url), spreadMs: 0, localOffsetMs: 0 };
  }
  const times = used.map((u) => u.epochMs!);
  const spreadMs = Math.max(...times) - Math.min(...times);
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
  const localOffsetMs = localMs - median;
  const verdict = spreadMs <= toleranceMs && Math.abs(localOffsetMs) <= toleranceMs ? "SYNCED" : "DRIFT";
  return { verdict, usedUrls: used.map((u) => u.url), spreadMs, localOffsetMs };
}

// ── input validation (v1.5.0 input law) ──────────────────────────────────────

type InputError = { ok: false; error: string };
type Validated<T> = { ok: true; value: T } | InputError;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** null when v is a usable non-empty string, else the named complaint. */
function field(v: unknown, name: string): string | null {
  return typeof v === "string" && v.length > 0 ? null : `field "${name}": expected non-empty string`;
}

/** Parse a caller JSON into an array of bounded size; every failure names the
 * field and the reason (an INPUT rejection, not an internal error). */
export function parseJsonArray(raw: string, field: string, maxItems: number): Validated<unknown[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `${field}: not valid JSON (${errMessage(e).slice(0, 160)})` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `${field}: expected a JSON array` };
  if (parsed.length > maxItems) {
    return { ok: false, error: `${field}: ${String(parsed.length)} entries exceeds the ${String(maxItems)} cap` };
  }
  return { ok: true, value: parsed };
}

function firstEntryError<T>(list: readonly unknown[], check: (entry: unknown) => string | null, map: (entry: Record<string, unknown>) => T): Validated<T[]> {
  for (let i = 0; i < list.length; i += 1) {
    const why = check(list[i]);
    if (why !== null) return { ok: false, error: `entry #${String(i)}: ${why}` };
  }
  // check() already proved every entry is a record before map() runs
  return { ok: true, value: list.map((e) => map(e as Record<string, unknown>)) };
}

export function validateTimeSources(list: readonly unknown[]): Validated<TimeSource[]> {
  return firstEntryError(
    list,
    (e) => {
      if (!isRecord(e)) return "expected object {url,ownerDept}";
      return field(e["url"], "url") ?? field(e["ownerDept"], "ownerDept");
    },
    (r) => ({ url: r["url"] as string, ownerDept: r["ownerDept"] as string }),
  );
}

export function validateMoves(list: readonly unknown[]): Validated<RefMove[]> {
  return firstEntryError(
    list,
    (e) => {
      if (!isRecord(e)) return "expected object {remote,ref,oldSha,newSha}";
      const shape = field(e["remote"], "remote") ?? field(e["ref"], "ref") ?? field(e["newSha"], "newSha");
      if (shape !== null) return shape;
      if (e["oldSha"] !== undefined && e["oldSha"] !== null && typeof e["oldSha"] !== "string") return 'field "oldSha": expected string or null';
      return null;
    },
    (r) => ({ remote: r["remote"] as string, ref: r["ref"] as string, oldSha: (r["oldSha"] as string | null | undefined) ?? null, newSha: r["newSha"] as string }),
  );
}

export function validateRoster(list: readonly unknown[]): Validated<RosterEntry[]> {
  return firstEntryError(
    list,
    (e) => {
      if (!isRecord(e)) return "expected object {name,email,keyFingerprint?}";
      const shape = field(e["name"], "name") ?? field(e["email"], "email");
      if (shape !== null) return shape;
      if (e["keyFingerprint"] !== undefined && typeof e["keyFingerprint"] !== "string") return 'field "keyFingerprint": expected string';
      return null;
    },
    (r) => {
      const entry = { name: r["name"] as string, email: r["email"] as string };
      return typeof r["keyFingerprint"] === "string" ? { ...entry, keyFingerprint: r["keyFingerprint"] } : entry;
    },
  );
}

// ── egress gate (SSRF fail-closed over URL literal shapes) ───────────────────

export type EgressVerdict = { ok: true; host: string } | { ok: false; reason: string };

const REJECT_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".home", ".lan", ".private", ".intranet", ".corp"] as const;

function privateV4Reason(host: string): string | null {
  const parts = host.split(".");
  if (parts.length !== 4) return "malformed-ipv4";
  const n = parts.map((p) => (p.length > 0 && p.length <= 3 && /^[0-9]+$/.test(p) ? Number(p) : 256));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return "malformed-ipv4";
  const [a, b] = [n[0]!, n[1]!];
  if (a === 0) return "this-network-0/8";
  if (a === 10) return "private-10/8";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat-100.64/10";
  if (a === 127) return "loopback-127/8";
  if (a === 169 && b === 254) return "linklocal-169.254/16";
  if (a === 172 && b >= 16 && b <= 31) return "private-172.16/12";
  if (a === 192 && b === 0 && n[2] === 0) return "ietf-protocol-192.0.0/24";
  if (a === 192 && b === 0 && n[2] === 2) return "doc-test-192.0.2/24";
  if (a === 192 && b === 168) return "private-192.168/16";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark-198.18/15";
  if (a === 198 && b === 51 && n[2] === 100) return "doc-test-198.51.100/24";
  if (a === 203 && b === 0 && n[2] === 113) return "doc-test-203.0.113/24";
  if (a >= 224 && a <= 239) return "multicast-224/4";
  if (a >= 240) return "reserved-240/4";
  return null;
}

/** Expand an IPv6 literal to EXACTLY eight 16-bit words ("::" compressed form
 * expanded once, trailing dotted-quad folded into two words). null = malformed
 * (fail-closed: an address we cannot expand cannot be cleared either). */
function expandV6(addr: string): number[] | null {
  const zoneless = addr.split("%")[0]!;
  const halves = zoneless.split("::");
  if (halves.length > 2) return null;
  const tail = (halves.length === 2 ? halves[1] : halves[0]) ?? "";
  const head = (halves.length === 2 ? halves[0] : "") ?? "";
  const foldWord = (w: string): number | null => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : null);
  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const items = side.split(":");
    const last = items[items.length - 1]!;
    const words: number[] = [];
    if (last.includes(".")) {
      const octets = last.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      items.pop();
    }
    for (const w of items) {
      if (w.length === 0) return null; // stray empty group outside "::"
      const word = foldWord(w);
      if (word === null) return null;
      words.push(word);
    }
    return words;
  };
  const headWords = parseSide(head);
  const tailWords = parseSide(tail);
  if (headWords === null || tailWords === null) return null;
  if (halves.length === 1) {
    return headWords.length === 8 ? headWords : null;
  }
  const gap = 8 - headWords.length - tailWords.length;
  if (gap < 1) return null;
  return [...headWords, ...Array.from({ length: gap }, () => 0), ...tailWords];
}

/** Classify an IPv6 literal (brackets already stripped). Covers the
 * unspecified/loopback/IPv4-embedded (mapped + deprecated compat)/ULA/link-local/
 * multicast families, and 6to4 2002::/16 with its embedded v4 re-checked. The
 * address is parsed via expandV6 so "::" compression and the WHATWG serializer's
 * colon-hex forms (e.g. ::ffff:7f00:1) are all handled, not just pretty text. */
function privateV6Reason(inner: string): string | null {
  const addr = inner.toLowerCase();
  if (addr === "" || addr === "::") return "v6-unspecified";
  if (addr === "::1") return "v6-loopback";
  const words = expandV6(addr);
  if (words === null) return "malformed-ipv6";
  const v4Embedded = (w6: number, w7: number): string | null =>
    privateV4Reason(`${String(w6 >> 8)}.${String(w6 & 0xff)}.${String(w7 >> 8)}.${String(w7 & 0xff)}`);
  const head5Zero = words.slice(0, 5).every((w) => w === 0);
  if (head5Zero && words[5] === 0xffff) {
    const v4 = v4Embedded(words[6]!, words[7]!);
    return v4 === null ? null : `v6-mapped-${v4}`;
  }
  if (words.slice(0, 6).every((w) => w === 0)) {
    // deprecated v4-compatible ::a.b.c.d still reaches the v4 stack
    const v4 = v4Embedded(words[6]!, words[7]!);
    return v4 === null ? null : `v6-v4compat-${v4}`;
  }
  const top = words[0]!;
  if ((top & 0xfe00) === 0xfc00) return "v6-ula-fc00::/7";
  if ((top & 0xffc0) === 0xfe80) return "v6-linklocal-fe80::/10";
  if ((top & 0xfff0) === 0xff00) return "v6-multicast-ff00::/12";
  if (top === 0x2002) {
    const v4 = v4Embedded(words[1]!, words[2]!);
    return v4 === null ? null : `v6-6to4-${v4}`;
  }
  return null;
}

const V4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Pure, offline SSRF gate over the URL's LITERAL shape: scheme, userinfo,
 * port, IP-literal reserved ranges (the WHATWG URL parser has already
 * normalized decimal/hex/octal IPv4 encodings), single-label hosts and
 * internal name suffixes. Rejection is by rule name. NAMED LIMITATION
 * (SECURITY.md): a public hostname resolving to an internal address is not
 * caught here — the fetch API cannot pin the connection to a verified IP. */
export function classifyEgress(rawUrl: string): EgressVerdict {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not-a-parsable-url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `scheme-${u.protocol.replace(":", "")}-forbidden` };
  if (u.username.length > 0 || u.password.length > 0) return { ok: false, reason: "userinfo-forbidden" };
  if (u.port.length > 0) return { ok: false, reason: `port-${u.port}-forbidden` };
  let host = u.hostname;
  if (host.startsWith("[")) {
    const why = privateV6Reason(host.slice(1, -1));
    return why === null ? { ok: true, host } : { ok: false, reason: why };
  }
  if (V4_LITERAL.test(host)) {
    const why = privateV4Reason(host);
    return why === null ? { ok: true, host } : { ok: false, reason: why };
  }
  host = host.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost") return { ok: false, reason: "loopback-localhost" };
  if (!host.includes(".")) return { ok: false, reason: "single-label-host" };
  for (const suffix of REJECT_SUFFIXES) {
    if (host.endsWith(suffix)) return { ok: false, reason: `internal-suffix${suffix}` };
  }
  return { ok: true, host };
}

// ── attribution comparator ───────────────────────────────────────────────────

export type RefMove = { readonly remote: string; readonly ref: string; readonly oldSha: string | null; readonly newSha: string };
export type CommitMeta = { readonly sha: string; readonly committerName: string; readonly committerEmail: string; readonly signedByKey: string | null };
export type RosterEntry = { readonly name: string; readonly email: string; readonly keyFingerprint?: string | undefined };

export type Attribution = {
  readonly verdict: "ATTRIBUTED" | "UNATTRIBUTED" | "AMBIGUOUS";
  readonly detail: string;
};

function equalBytes(a: string, b: string): boolean {
  return a === b; // closed normalization: NONE. bytes are bytes (identity gate law).
}

/** Attribute each ref move to its new commit's committer identity against the
 * roster. UNATTRIBUTED = the silent-egress case (move with no registered
 * identity behind it); AMBIGUOUS = roster itself contains a byte-equal pair for
 * this committer, which is a registry defect and blocks, never picks. */
export function attributeRange(moves: readonly RefMove[], commits: readonly CommitMeta[], roster: readonly RosterEntry[]): Attribution[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  return moves.map((m) => {
    const c = bySha.get(m.newSha);
    if (c === undefined) return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: new commit ${m.newSha.slice(0, 12)} not in supplied commit set` };
    const hits = roster.filter((r) => equalBytes(r.name, c.committerName) && equalBytes(r.email, c.committerEmail));
    if (hits.length === 0) return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: committer "${c.committerName} <${c.committerEmail}>" has no ACTIVE roster binding` };
    if (hits.length > 1) return { verdict: "AMBIGUOUS", detail: `${m.remote} ${m.ref}: ${hits.length} roster entries byte-equal — registry defect, needs human dedup workorder` };
    const hit = hits[0]!;
    if (c.signedByKey !== null && hit.keyFingerprint !== undefined && !equalBytes(c.signedByKey, hit.keyFingerprint)) {
      return { verdict: "UNATTRIBUTED", detail: `${m.remote} ${m.ref}: signed by key ${c.signedByKey.slice(0, 12)} != roster binding ${hit.keyFingerprint.slice(0, 12)} (bytes-claim without signature)` };
    }
    return { verdict: "ATTRIBUTED", detail: `${m.remote} ${m.ref} -> ${hit.name} <${hit.email}>${hit.keyFingerprint !== undefined ? ` key=${hit.keyFingerprint.slice(0, 12)}` : ""}` };
  });
}

/** Parse `git log --format=%H|%cn|%ce|%GK` output (unsigned rows emit an empty key field). */
export function parseCommitMeta(stdout: string): CommitMeta[] {
  return stdout.split("\n").filter((l) => l.includes("|")).map((l) => {
    const [sha = "", committerName = "", committerEmail = "", gk = ""] = l.split("|");
    return { sha: sha.trim(), committerName: committerName ?? "", committerEmail: committerEmail ?? "", signedByKey: (gk ?? "").trim() === "" ? null : (gk ?? "").trim() };
  });
}

// ── tool surface ─────────────────────────────────────────────────────────────

export const TIME_PROBE_TOOL_NAME = "sibyl_time_probe";
export const ATTRIBUTE_TOOL_NAME = "sibyl_attribute";

export type TimeProbeArgs = { endpoints?: string | undefined; toleranceMs?: number | undefined };

/** execute() body, exported for offline tests (auditExecute seam pattern):
 * validation + egress gate run at the boundary, fetch stays injectable. */
export async function timeProbeExecute(
  args: TimeProbeArgs,
  seams: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const parsedSources: Validated<TimeSource[]> = (() => {
    const raw = args.endpoints;
    if (raw === undefined) return { ok: true, value: [...DEFAULT_TIME_POOL] } as const;
    const arr = parseJsonArray(raw, "endpoints", MAX_TIME_SOURCES);
    return arr.ok ? validateTimeSources(arr.value) : arr;
  })();
  if (!parsedSources.ok) return `SIBYL ${TIME_PROBE_TOOL_NAME} INPUT REJECTED: ${parsedSources.error}`;

  const gate = parsedSources.value.map((s) => ({ source: s, verdict: classifyEgress(s.url) }));
  const allowed = gate.filter((g) => g.verdict.ok).map((g) => g.source);
  const blocked: ProbeReceipt[] = gate.flatMap((g) =>
    g.verdict.ok ? [] : [{ url: g.source.url, ownerDept: g.source.ownerDept, ok: false, error: `blocked-egress:${g.verdict.reason}` }],
  );
  if (allowed.length === 0) {
    return [
      "SIBYL TIME INSUFFICIENT-SOURCES",
      "used=",
      `spread_ms=0 local_offset_ms=0 tolerance_ms=${String(args.toleranceMs ?? 300_000)}`,
      ...blocked.map((r) => `fail ${r.url} (${r.ownerDept}) — ${r.error}`),
    ].join("\n");
  }
  const receipts = [...blocked, ...(await probeTimes(allowed, seams.fetchImpl ?? fetch))];
  const c = consensus(receipts, Date.now(), args.toleranceMs);
  return [
    `SIBYL TIME ${c.verdict}`,
    `used=${c.usedUrls.join(",")}`,
    `spread_ms=${String(c.spreadMs)} local_offset_ms=${String(c.localOffsetMs)} tolerance_ms=${String(args.toleranceMs ?? 300_000)}`,
    ...receipts.map((r) => `${r.ok ? "ok" : "fail"} ${r.url} (${r.ownerDept})${r.error !== undefined ? ` — ${r.error}` : ` — ${new Date(r.epochMs ?? 0).toISOString()}`}`),
  ].join("\n");
}

export type AttributeArgs = { moves: string; commits: string; roster: string };

/** execute() body, exported for offline tests: every caller array passes its
 * shape validator before attributeRange ever sees it. */
export function attributeExecute(args: AttributeArgs): string {
  const movesArr = parseJsonArray(args.moves, "moves", MAX_INPUT_ITEMS);
  if (!movesArr.ok) return `SIBYL ${ATTRIBUTE_TOOL_NAME} INPUT REJECTED: ${movesArr.error}`;
  const moves = validateMoves(movesArr.value);
  if (!moves.ok) return `SIBYL ${ATTRIBUTE_TOOL_NAME} INPUT REJECTED: moves ${moves.error}`;
  const rosterArr = parseJsonArray(args.roster, "roster", MAX_INPUT_ITEMS);
  if (!rosterArr.ok) return `SIBYL ${ATTRIBUTE_TOOL_NAME} INPUT REJECTED: ${rosterArr.error}`;
  const roster = validateRoster(rosterArr.value);
  if (!roster.ok) return `SIBYL ${ATTRIBUTE_TOOL_NAME} INPUT REJECTED: roster ${roster.error}`;

  const results = attributeRange(moves.value, parseCommitMeta(args.commits), roster.value);
  const head = results.every((r) => r.verdict === "ATTRIBUTED") ? "ALL ATTRIBUTED"
    : results.some((r) => r.verdict === "UNATTRIBUTED") ? "UNATTRIBUTED MOVES PRESENT (fatal class)"
    : "AMBIGUOUS — registry defect";
  return [`SIBYL ATTRIBUTE: ${head}`, ...results.map((r) => `${r.verdict} :: ${r.detail}`)].join("\n");
}

export function buildTimeProbeTool(deps: ToolDeps) {
  void deps;
  return tool({
    description:
      "SIBYL time probe (g12b-8): read HTTP Date headers from >=2 operator-distinct remote sources and compare " +
      "against the local clock — verdict SYNCED / DRIFT / INSUFFICIENT-SOURCES with spread and offset in ms. " +
      "Same-owner sources collapse to one; fewer than two distinct owners can NEVER certify time. " +
      "Endpoints are shape-validated and egress-gated: loopback/private/link-local/metadata shapes and " +
      "internal name suffixes are refused by rule name (blocked sources count as failed receipts).",
    args: {
      endpoints: tool.schema.string().optional().describe("JSON array of {url,ownerDept}; defaults to the built-in cloudflare/google/mozilla pool."),
      toleranceMs: tool.schema.number().int().positive().optional().describe("Accepted spread/offset in ms (default 300000 = 5 min, HTTP-date + proxy slop)."),
    },
    execute: async (args, _context: ToolContextLike) => {
      try {
        return await timeProbeExecute(args, { fetchImpl: fetch });
      } catch (e) {
        return internalError("sibyl_time_probe", e);
      }
    },
  });
}

export function buildAttributeTool(deps: ToolDeps) {
  void deps;
  return tool({
    description:
      "SIBYL attribution (g12b-4): compare supplied ref moves (remote/ref/old/new) against commit metadata and a " +
      "roster (identity+key bindings, ACTIVE entries) — per-move verdict ATTRIBUTED / UNATTRIBUTED / AMBIGUOUS. " +
      "Byte-exact comparison, no normalization; unknown commits and missing bindings are UNATTRIBUTED (silent " +
      "egress is fatal-class), byte-equal roster duplicates are AMBIGUOUS registry defects. Inputs are read-only " +
      "strings the CALLER captured (git log / ls-remote output) — this tool never shells out. " +
      "Malformed or mis-shaped JSON arrays are refused by name, never guessed at.",
    args: {
      moves: tool.schema.string().describe("JSON array of {remote,ref,oldSha,newSha}."),
      commits: tool.schema.string().describe("`git log --format=%H|%cn|%ce|%GK` output covering the moved-to commits (newest first or any order)."),
      roster: tool.schema.string().describe("JSON array of {name,email,keyFingerprint?} — the registered identity bindings."),
    },
    execute: async (args) => {
      try {
        return attributeExecute(args);
      } catch (e) {
        return internalError("sibyl_attribute", e);
      }
    },
  });
}
