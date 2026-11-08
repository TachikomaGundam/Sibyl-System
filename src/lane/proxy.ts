// provenance: original clean-room Sibyl-System implementation (v1.7 credential
// relay). Optional per-run loopback proxy that OWNS the real provider keys so
// isolated roles never receive them (configSource copies could carry inline
// apiKey; with the relay on, roles get no configSource at all).
//
// Security laws (design-to-threat):
// - Loopback only: binds 127.0.0.1:0 (ephemeral); the relay is not offered on
//   any other interface, and the role learns only that loopback URL.
// - Capability tokens: each (role, provider) gets one random 256-bit token,
//   held here by SHA-256 digest. The TOKEN - never anything the role sends -
//   selects the upstream and carries a hard per-role request quota.
// - Closed path grammar: a fixed OpenAI-compatible endpoint set is proxied;
//   anything else is denied before any upstream contact.
// - Credential replacement: the role's bearer token is stripped; the real key
//   is attached here. keyless upstreams receive no authorization header at all.
// - No redirects: any 3xx from an upstream is refused (502), never followed.
// - Receipts: one jsonl line per request - role/provider/method/path/status and
//   quota ONLY. Zero credentials, zero headers, zero request/response bodies.
// - Node stdlib only. The public surface returns structured results and never
//   throws; internal handler faults collapse into 500 + a receipt line.

import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ProxyUpstream } from "../options.ts";
import { errMessage } from "../util.ts";
import { readBody, streamToClient } from "./relay-http.ts";

/** Closed grammar: exactly these endpoints get proxied (case-sensitive paths). */
const POST_PATHS: readonly string[] = ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/responses"];

/** What a role config needs to talk to the relay (consumed by
 * src/lane/isolated.ts synthesizeProxyConfig; it is NOT a host credential). */
export type RoleProxyConfig = {
  relayBaseUrl: string;
  roleToken: string;
  providerID: string;
  npm: string;
  models: readonly string[];
};

export type CredentialProxy = {
  readonly relayBaseUrl: string;
  /** Mint (or reuse) the scoped token for one (role, provider) pair. */
  issueRole(role: string, providerID: string): { ok: true; config: RoleProxyConfig } | { ok: false; error: string };
  close(): Promise<void>;
};

export type StartProxyOptions = {
  upstreams: Readonly<Record<string, ProxyUpstream>>;
  maxRequestsPerRole: number;
  receiptsPath: string;
};

export type StartProxyResult = { ok: true; proxy: CredentialProxy } | { ok: false; error: string };

type ResolvedUpstream = { baseUrl: string; authHeader: string | null; npm: string; models: readonly string[] };
type RoleSeat = { role: string; providerID: string; used: number };

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Keys resolve ONCE at startup - later file/env churn never silently swaps
 * a provider's identity mid-run. Every failure names the config path to fix. */
async function resolveUpstream(providerID: string, spec: ProxyUpstream): Promise<{ ok: true; upstream: ResolvedUpstream } | { ok: false; error: string }> {
  const where = `credentialProxy.providers.${providerID}`;
  let key: string | null = null;
  if (spec.keyFile !== undefined) {
    let text: string;
    try {
      text = await readFile(spec.keyFile, "utf8");
    } catch (err) {
      return { ok: false, error: `${where}.keyFile is unreadable ("${spec.keyFile}"): ${errMessage(err)} — fix the path, or switch to keyEnv/keyless` };
    }
    key = text.trim();
    if (key.length === 0) return { ok: false, error: `${where}.keyFile ("${spec.keyFile}") is empty` };
  } else if (spec.keyEnv !== undefined) {
    const value = process.env[spec.keyEnv];
    if (value === undefined || value.trim().length === 0) {
      return {
        ok: false,
        error: `${where}.keyEnv names "${spec.keyEnv}", which is unset or empty in the runner environment — export it before launching, or switch to keyFile/keyless`,
      };
    }
    key = value.trim();
  }
  return {
    ok: true,
    upstream: {
      baseUrl: spec.baseUrl.replace(/\/+$/, ""),
      authHeader: key === null ? null : `Bearer ${key}`,
      npm: spec.npm,
      models: spec.models,
    },
  };
}

/** Start the loopback relay. Resolves ok:false (with an actionable, named
 * error) when any upstream credential is missing or the bind fails; in that
 * case nothing has to be cleaned up. */
export async function startCredentialProxy(opts: StartProxyOptions): Promise<StartProxyResult> {
  const upstreams = new Map<string, ResolvedUpstream>();
  for (const [providerID, spec] of Object.entries(opts.upstreams)) {
    const resolved = await resolveUpstream(providerID, spec);
    if (!resolved.ok) return resolved;
    upstreams.set(providerID, resolved.upstream);
  }

  const seats = new Map<string, RoleSeat>();
  const minted = new Map<string, RoleProxyConfig>();
  const inflight = new Set<AbortController>();

  const server: Server = createServer();
  let relayBaseUrl = "";

  const recordReceipt = async (seat: RoleSeat | null, method: string, path: string, status: number): Promise<void> => {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      role: seat?.role ?? "anonymous",
      providerID: seat?.providerID ?? "-",
      method,
      path,
      status,
      quotaRemaining: seat === null ? null : Math.max(opts.maxRequestsPerRole - seat.used, 0),
    })}\n`;
    try {
      await appendFile(opts.receiptsPath, line, "utf8");
    } catch (err) {
      // a broken receipt stream must not forge a model call, but it must not
      // vanish silently either: the loss itself goes to stderr.
      process.stderr.write(`sibyl-proxy: receipt write failed (${errMessage(err)})\n`);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", relayBaseUrl).pathname;
    } catch {
      // unparseable request target stays "/" -> the closed set denies it
    }
    let seat: RoleSeat | null = null;

    const denied = async (status: number, code: string, message: string): Promise<void> => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code, message } }));
      await recordReceipt(seat, method, pathname, status);
    };

    const bearer = /^Bearer ([0-9a-f]{16,256})$/.exec(req.headers.authorization ?? "");
    if (bearer === null || bearer[1] === undefined) {
      return denied(401, "auth_missing", "relay requires the role bearer token in the authorization header");
    }
    seat = seats.get(digest(bearer[1])) ?? null;
    if (seat === null) return denied(401, "auth_invalid", "unknown role token");

    if (seat.used >= opts.maxRequestsPerRole) {
      return denied(429, "quota_exceeded", `role "${seat.role}" exhausted its quota of ${String(opts.maxRequestsPerRole)} requests`);
    }
    seat.used += 1;

    const pathOk =
      method === "POST"
        ? POST_PATHS.includes(pathname)
        : method === "GET" && (pathname === "/v1/models" || pathname.startsWith("/v1/models/"));
    if (!pathOk) {
      return denied(404, "path_denied", `path "${pathname}" is not a permitted OpenAI-compatible endpoint of this relay`);
    }

    const upstream = upstreams.get(seat.providerID);
    if (upstream === undefined) return denied(502, "upstream_gone", `provider "${seat.providerID}" is no longer configured on the relay`);

    let body: Buffer | undefined;
    if (method === "POST") {
      const read = await readBody(req);
      if (!read.ok) return denied(read.status, read.code, read.message);
      body = read.body;
    }

    const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
    if (body !== undefined) {
      const ct = req.headers["content-type"];
      headers["content-type"] = typeof ct === "string" ? ct : "application/json";
    }
    if (upstream.authHeader !== null) headers.authorization = upstream.authHeader;

    const abort = new AbortController();
    inflight.add(abort);
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstream.baseUrl + (req.url ?? "/"), {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: abort.signal,
      });
    } catch (err) {
      inflight.delete(abort);
      return denied(502, "upstream_unreachable", `provider "${seat.providerID}" is unreachable at ${upstream.baseUrl}: ${errMessage(err)}`);
    }
    inflight.delete(abort);

    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      return denied(502, "redirect_refused", `provider "${seat.providerID}" answered ${String(upstreamRes.status)}; the relay never follows redirects`);
    }

    res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") ?? "application/json" });
    if (upstreamRes.body !== null) await streamToClient(upstreamRes.body, res);
    else res.end();
    await recordReceipt(seat, method, pathname, upstreamRes.status);
  };

  server.on("request", (req, res) => {
    handle(req, res).catch(async (err: unknown) => {
      process.stderr.write(`sibyl-proxy: handler fault (${errMessage(err)})\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "relay_error", message: "internal relay fault" } }));
      }
      await recordReceipt(null, req.method ?? "GET", "/", 500);
    });
  });

  const bindError = await new Promise<string | null>((resolvePromise) => {
    server.once("error", (err) => resolvePromise(errMessage(err)));
    server.listen(0, "127.0.0.1", () => resolvePromise(null));
  });
  if (bindError !== null) return { ok: false, error: `credential relay failed to bind 127.0.0.1: ${bindError}` };
  // post-bind server faults must not take the runner down (fail-soft surface,
  // disclosed on stderr; individual requests still fail closed at 500).
  server.on("error", (err) => process.stderr.write(`sibyl-proxy: server fault (${errMessage(err)})\n`));
  const address = server.address();
  if (address === null || typeof address === "string") return { ok: false, error: "credential relay bind returned no TCP address" };
  relayBaseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    ok: true,
    proxy: {
      relayBaseUrl,
      issueRole(role: string, providerID: string): { ok: true; config: RoleProxyConfig } | { ok: false; error: string } {
        const upstream = upstreams.get(providerID);
        if (upstream === undefined) {
          const known = [...upstreams.keys()].join(", ") || "(none configured)";
          return {
            ok: false,
            error: `provider "${providerID}" has no entry in credentialProxy.providers (known: ${known}) — add its upstream or seat this role on a proxied provider`,
          };
        }
        const key = `${role}\u0000${providerID}`;
        const existing = minted.get(key);
        if (existing !== undefined) return { ok: true, config: existing };
        const roleToken = randomBytes(32).toString("hex");
        seats.set(digest(roleToken), { role, providerID, used: 0 });
        const config: RoleProxyConfig = { relayBaseUrl, roleToken, providerID, npm: upstream.npm, models: upstream.models };
        minted.set(key, config);
        return { ok: true, config };
      },
      close(): Promise<void> {
        return new Promise((resolvePromise) => {
          for (const abort of inflight) abort.abort();
          inflight.clear();
          seats.clear();
          minted.clear();
          server.closeAllConnections();
          server.close(() => resolvePromise());
        });
      },
    },
  };
}
