// provenance: v1.7 credential-proxy tests. Fully offline: the "upstream" is a
// local fake HTTP server and every key is a fake canary string; nothing
// external is contacted and no real credential exists anywhere on these paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { parseOptions, type ProxyUpstream } from "../src/options.ts";
import { startCredentialProxy, type CredentialProxy } from "../src/lane/proxy.ts";
import { prepareRoleHome, synthesizeProxyConfig, type LaneConfig } from "../src/lane/isolated.ts";
import { resolveRun } from "../src/cli.ts";

const CANARY_KEY = "sk-UPSTREAM-REAL-KEY-CANARY";
const BODY_MARK = "BODY-MUST-NEVER-REACH-RECEIPTS";
const HOST_CONFIG_SENTINEL = "HOST-CONFIG-INLINE-KEY-SENTINEL";

type FakeUpstream = {
  baseUrl: string;
  seen: { auth: string | undefined; path: string; body: string }[];
  close(): Promise<void>;
};

/** Local stand-in for a real provider: records what it was handed and echoes
 * the received authorization back so credential replacement is observable. */
async function fakeUpstream(): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const auth = req.headers.authorization;
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ auth, path, body });
      if (path === "/v1/completions") {
        res.writeHead(302, { location: "http://127.0.0.1:1/moved" });
        res.end();
        return;
      }
      if (path === "/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: a\n\n");
        setTimeout(() => res.end("data: b\n\n"), 500);
        return;
      }
      if (path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"object":"list","data":[]}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sawAuth: auth ?? null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function startRelay(
  t: { after: (fn: () => unknown) => void },
  upstreams: Readonly<Record<string, ProxyUpstream>>,
  maxRequestsPerRole = 10,
): Promise<{ proxy: CredentialProxy; receiptsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receiptsPath = join(dir, "proxy-receipts.jsonl");
  const started = await startCredentialProxy({ upstreams, maxRequestsPerRole, receiptsPath });
  if (!started.ok) assert.fail(`relay start failed: ${started.error}`);
  t.after(() => started.proxy.close());
  return { proxy: started.proxy, receiptsPath };
}

function relayFetch(proxy: CredentialProxy, path: string, token?: string, body?: string): Promise<Response> {
  return fetch(`${proxy.relayBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

// --- options schema -----------------------------------------------------------

test("credentialProxy absent: present semantics preserved exactly (undefined, defaults intact)", () => {
  const r = parseOptions({});
  if (!r.ok) assert.fail(r.errors.join("; "));
  assert.equal(r.options.credentialProxy, undefined);
});

test("credentialProxy parses: quota defaults 2000, npm default, models default empty", () => {
  const r = parseOptions({
    credentialProxy: { providers: { cloudx: { baseUrl: "https://api.cloudx.test/v1", keyEnv: "CLOUDX_KEY" } } },
  });
  if (!r.ok) assert.fail(r.errors.join("; "));
  const cp = r.options.credentialProxy;
  assert.ok(cp !== undefined);
  assert.equal(cp.maxRequestsPerRole, 2000);
  const up = cp.providers["cloudx"];
  assert.ok(up !== undefined);
  assert.equal(up.keyEnv, "CLOUDX_KEY");
  assert.equal(up.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(up.models, []);
});

test("credentialProxy strict battery: two-of/zero-of key union, credentialed URL, unknown keys, quota floor all refused", () => {
  const refuses = (raw: unknown, fragment: string): void => {
    const r = parseOptions({ credentialProxy: raw });
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(raw)}`);
    if (!r.ok) assert.ok(r.errors.join("; ").includes(fragment), `errors missing "${fragment}": ${r.errors.join("; ")}`);
  };
  refuses({ providers: { a: { baseUrl: "http://h:1/", keyFile: "/k", keyEnv: "E" } } }, "exactly one");
  refuses({ providers: { a: { baseUrl: "http://h:1/", keyless: true, keyFile: "/k" } } }, "exactly one");
  refuses({ providers: { a: { baseUrl: "http://h:1/" } } }, "exactly one");
  refuses({ providers: { a: { baseUrl: "https://sk-x@h/", keyless: true } } }, "without embedded credentials");
  refuses({ providers: { a: { baseUrl: "http://h:1/", keyless: true, extra: 1 } } }, "extra");
  refuses({ providers: {}, maxRequestsPerRole: 0 }, "maxRequestsPerRole");
});

// --- relay behavior -------------------------------------------------------------

test("relay replaces the role token with the real key and forwards the body verbatim", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key");
  await writeFile(keyFile, `${CANARY_KEY}\n`, "utf8");
  const { proxy } = await startRelay(t, { fake: { baseUrl: up.baseUrl, keyFile, npm: "@ai-sdk/openai-compatible", models: ["m1"] } });
  assert.ok(proxy.relayBaseUrl.startsWith("http://127.0.0.1:"), "loopback only");

  const issued = proxy.issueRole("pro", "fake");
  if (!issued.ok) assert.fail(issued.error);
  assert.match(issued.config.roleToken, /^[0-9a-f]{64}$/);
  const again = proxy.issueRole("pro", "fake");
  assert.equal(again.ok && again.config.roleToken, issued.config.roleToken, "same role+provider reuses its token");

  const res = await relayFetch(proxy, "/v1/chat/completions", issued.config.roleToken, JSON.stringify({ model: "m1", prompt: BODY_MARK }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; sawAuth: string | null };
  assert.deepEqual(json, { ok: true, sawAuth: `Bearer ${CANARY_KEY}` }, "upstream sees ONLY the real key");
  assert.equal(up.seen.length, 1);
  assert.equal(up.seen[0]?.auth, `Bearer ${CANARY_KEY}`);
  assert.ok((up.seen[0]?.body ?? "").includes(BODY_MARK), "request body forwarded intact");
});

test("relay streams upstream responses chunk-by-chunk (SSE passthrough, content-type kept)", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const { proxy } = await startRelay(t, { fake: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } });
  const issued = proxy.issueRole("pro", "fake");
  if (!issued.ok) assert.fail(issued.error);
  const res = await relayFetch(proxy, "/v1/responses", issued.config.roleToken, "{}");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body?.getReader();
  assert.ok(reader !== undefined);
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "data: a\n\n", "first chunk arrives before upstream end (not buffered)");
  const rest = await reader.read();
  assert.equal(new TextDecoder().decode(rest.value), "data: b\n\n");
});

test("relay rejects missing/unknown tokens and paths outside the closed set", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const { proxy } = await startRelay(t, { fake: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } });
  const issued = proxy.issueRole("pro", "fake");
  if (!issued.ok) assert.fail(issued.error);
  const token = issued.config.roleToken;

  const noAuth = await relayFetch(proxy, "/v1/chat/completions", undefined, "{}");
  assert.equal(noAuth.status, 401);
  assert.equal(((await noAuth.json()) as { error: { code: string } }).error.code, "auth_missing");

  const bad = await relayFetch(proxy, "/v1/chat/completions", "0".repeat(64), "{}");
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "auth_invalid");

  const admin = await relayFetch(proxy, "/v1/admin", token, "{}");
  assert.equal(admin.status, 404);
  assert.equal(((await admin.json()) as { error: { code: string } }).error.code, "path_denied");

  const wrongMethod = await relayFetch(proxy, "/v1/chat/completions", token);
  assert.equal(wrongMethod.status, 404, "GET on a POST-only path is outside the closed set");

  const models = await relayFetch(proxy, "/v1/models", token);
  assert.equal(models.status, 200, "GET /v1/models is inside the closed set");
  assert.equal(up.seen.length, 1, "only the permitted /v1/models call reached the upstream; every denial stopped at the relay");
});

test("relay enforces the per-role quota", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const { proxy } = await startRelay(t, { fake: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } }, 1);
  const issued = proxy.issueRole("candidate", "fake");
  if (!issued.ok) assert.fail(issued.error);
  const first = await relayFetch(proxy, "/v1/chat/completions", issued.config.roleToken, "{}");
  assert.equal(first.status, 200);
  const second = await relayFetch(proxy, "/v1/chat/completions", issued.config.roleToken, "{}");
  assert.equal(second.status, 429);
  assert.equal(((await second.json()) as { error: { code: string } }).error.code, "quota_exceeded");
});

test("keyless upstream: relay forwards with NO authorization header at all", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const { proxy } = await startRelay(t, { local: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } });
  const issued = proxy.issueRole("pro", "local");
  if (!issued.ok) assert.fail(issued.error);
  const res = await relayFetch(proxy, "/v1/chat/completions", issued.config.roleToken, "{}");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { sawAuth: string | null };
  assert.equal(json.sawAuth, null, "keyless means the upstream receives no credential");
});

test("relay refuses upstream redirects instead of following them", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const { proxy } = await startRelay(t, { fake: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } });
  const issued = proxy.issueRole("pro", "fake");
  if (!issued.ok) assert.fail(issued.error);
  const res = await relayFetch(proxy, "/v1/completions", issued.config.roleToken, "{}");
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "redirect_refused");
});

test("relay start fails closed with actionable errors for missing credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "src-proxy-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missingEnv = await startCredentialProxy({
    upstreams: { gone: { baseUrl: "http://127.0.0.1:9", keyEnv: "SIBYL_PROXY_TEST_UNSET_KEY", npm: "n", models: [] } },
    maxRequestsPerRole: 1,
    receiptsPath: join(dir, "r.jsonl"),
  });
  assert.equal(missingEnv.ok, false);
  if (!missingEnv.ok) {
    assert.match(missingEnv.error, /credentialProxy\.providers\.gone\.keyEnv/);
    assert.match(missingEnv.error, /SIBYL_PROXY_TEST_UNSET_KEY/);
  }
  const missingFile = await startCredentialProxy({
    upstreams: { gone: { baseUrl: "http://127.0.0.1:9", keyFile: join(dir, "nope"), npm: "n", models: [] } },
    maxRequestsPerRole: 1,
    receiptsPath: join(dir, "r.jsonl"),
  });
  assert.equal(missingFile.ok, false);
  if (!missingFile.ok) assert.match(missingFile.error, /keyFile is unreadable/);
});

test("relay receipts are jsonl and omit every credential, token and body", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-rx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key");
  await writeFile(keyFile, CANARY_KEY, "utf8");
  const receiptsPath = join(dir, "proxy-receipts.jsonl");
  const started = await startCredentialProxy({
    upstreams: { fake: { baseUrl: up.baseUrl, keyFile, npm: "n", models: [] } },
    maxRequestsPerRole: 5,
    receiptsPath,
  });
  if (!started.ok) assert.fail(started.error);
  t.after(() => started.proxy.close());
  const issued = started.proxy.issueRole("pro", "fake");
  if (!issued.ok) assert.fail(issued.error);
  await relayFetch(started.proxy, "/v1/chat/completions", issued.config.roleToken, JSON.stringify({ prompt: BODY_MARK }));
  await relayFetch(started.proxy, "/v1/chat/completions", "f".repeat(64), "{}");

  const text = await readFile(receiptsPath, "utf8");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]?.role, rows[0]?.providerID, rows[0]?.path, rows[0]?.status], ["pro", "fake", "/v1/chat/completions", 200]);
  assert.equal(rows[1]?.role, "anonymous");
  assert.equal(rows[1]?.status, 401);
  assert.ok(!text.includes(CANARY_KEY), "receipts never carry the provider key");
  assert.ok(!text.includes(issued.config.roleToken), "receipts never carry role tokens");
  assert.ok(!text.includes(BODY_MARK), "receipts never carry request bodies");
});

test("relay close releases the port: later requests fail", async (t) => {
  const up = await fakeUpstream();
  t.after(() => up.close());
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started = await startCredentialProxy({
    upstreams: { fake: { baseUrl: up.baseUrl, keyless: true, npm: "n", models: [] } },
    maxRequestsPerRole: 5,
    receiptsPath: join(dir, "r.jsonl"),
  });
  if (!started.ok) assert.fail(started.error);
  const url = started.proxy.relayBaseUrl;
  await started.proxy.close();
  await assert.rejects(fetch(`${url}/v1/models`));
});

// --- role home synthesis --------------------------------------------------------

test("synthesizeProxyConfig: provider-only surface, token in the apiKey slot, models catalog", () => {
  const doc = synthesizeProxyConfig({
    relayBaseUrl: "http://127.0.0.1:9999",
    roleToken: "a".repeat(64),
    providerID: "cloudx",
    npm: "@ai-sdk/openai-compatible",
    models: ["m1", "m2"],
  });
  assert.deepEqual(doc, {
    provider: {
      cloudx: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9999", apiKey: "a".repeat(64) },
        models: { m1: { name: "m1" }, m2: { name: "m2" } },
      },
    },
  });
  assert.equal(synthesizeProxyConfig({ relayBaseUrl: "http://h", roleToken: "t", providerID: "p", npm: "n", models: [] }).provider["p"]?.models, undefined);
});

test("prepareRoleHome proxy mode: synthesized config only, configSource NOT copied, env stays secret-free", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configSource = join(dir, "host.jsonc");
  await writeFile(configSource, `{"provider":{"x":{"options":{"apiKey":"${HOST_CONFIG_SENTINEL}"}}}}\n`, "utf8");
  process.env.SIBYL_PROXY_CANARY_ENV = "host-secret-must-not-cross";
  t.after(() => delete process.env.SIBYL_PROXY_CANARY_ENV);
  const roleToken = "b".repeat(64);
  const cfg: LaneConfig = {
    runDir: join(dir, "run"),
    opencodeBin: "/bin/true",
    configSource,
    proxyRole: { relayBaseUrl: "http://127.0.0.1:9999", roleToken, providerID: "cloudx", npm: "@ai-sdk/openai-compatible", models: ["m1"] },
  };
  const { paths, env } = await prepareRoleHome(cfg, "pro");
  const text = await readFile(join(paths.home, ".config", "opencode", "opencode.jsonc"), "utf8");
  const doc = JSON.parse(text) as { provider: Record<string, { options: { baseURL: string; apiKey: string } }> };
  assert.equal(doc.provider["cloudx"]?.options.baseURL, "http://127.0.0.1:9999");
  assert.equal(doc.provider["cloudx"]?.options.apiKey, roleToken);
  assert.ok(!text.includes(HOST_CONFIG_SENTINEL), "the host config (with its inline key) never enters the role home");
  assert.equal(env.SIBYL_PROXY_CANARY_ENV, undefined, "host env secrets never reach a role process");
  assert.ok(!Object.values(env).some((v) => v !== undefined && v.includes(CANARY_KEY)));
  assert.equal(Object.keys(env).sort().join(","), "HOME,LANG,OPENCODE_DB,OPENCODE_DISABLE_AUTOUPDATE,PATH,XDG_CACHE_HOME,XDG_DATA_HOME,XDG_STATE_HOME");
});

// --- run-resolution fail-closed --------------------------------------------------

test("resolveRun: provider missing from the proxy map is refused before any spawn", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-deny-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "doc.md");
  await writeFile(target, "# doc\n", "utf8");
  const configPath = join(dir, "opts.json");
  await writeFile(
    configPath,
    JSON.stringify({
      modelPool: { default: { providerID: "cloudx", modelID: "m" } },
      credentialProxy: { providers: { other: { baseUrl: "http://127.0.0.1:8080", keyless: true } } },
    }),
    "utf8",
  );
  const r = await resolveRun({ target, goal: "g", config: configPath, "run-root": dir });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /cloudx/);
    assert.match(r.error, /credentialProxy\.providers/);
  }
});

test("resolveRun: proxied provider accepted and carried on the resolved run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-proxy-ok-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "doc.md");
  await writeFile(target, "# doc\n", "utf8");
  const configPath = join(dir, "opts.json");
  await writeFile(
    configPath,
    JSON.stringify({
      modelPool: { default: { providerID: "cloudx", modelID: "m" } },
      credentialProxy: { providers: { cloudx: { baseUrl: "http://127.0.0.1:8080", keyless: true, models: ["m"] } } },
    }),
    "utf8",
  );
  const r = await resolveRun({ target, goal: "g", config: configPath, "run-root": dir });
  if (!r.ok) assert.fail(r.error);
  assert.ok(r.run.credentialProxy !== null);
  assert.equal(r.run.credentialProxy?.maxRequestsPerRole, 2000);
  await rm(r.run.runDir, { recursive: true, force: true });
});
