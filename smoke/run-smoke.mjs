#!/usr/bin/env node
// Sibyl-System offline smoke kit (opencode 2.x platform). Deterministic, no
// live LLM, no network, no config writes: exercises only the SHIPPED surface of
// the built bundle (import -> plugin definition -> setup(ctx) -> tool registry
// -> sibyl_status). The run store is isolated via SIBYL_STATE_FILE into a
// throwaway sandbox that is always removed; your real ~/.sibyl store is never
// touched (no createRun, sibyl_status only reads).
//
// Usage: npm run build && node smoke/run-smoke.mjs
// Exit 0 = SMOKE PASS, 1 = SMOKE FAIL. One "ok"/"FAIL" line per check.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "ok  " : "FAIL"} ${name}`;
  console.log(detail === "" ? line : `${line} — ${detail}`);
  if (!ok) failed += 1;
  return ok;
}

// Isolation seam FIRST: the RunStore reads SIBYL_STATE_FILE at construction.
const sandbox = mkdtempSync(join(tmpdir(), "sibyl-smoke-"));
const stateFile = join(sandbox, "runs.json");
process.env.SIBYL_STATE_FILE = stateFile;

/** Minimal structural V2 plugin context; the engine is never called for real.
 * `get` answers the per-session directory lookup that the tool layer uses. */
function fakeContext(options) {
  const registered = [];
  const hooks = [];
  let transformCalls = 0;
  const ctx = {
    location: { directory: sandbox },
    options,
    session: {
      async get() {
        return { id: "ses_smoke", location: { directory: sandbox } };
      },
      async hook(name, cb) {
        hooks.push({ name, cb });
        return { dispose: async () => {} };
      },
    },
    tool: {
      async transform(cb) {
        transformCalls += 1;
        cb({
          add: (info) => registered.push(info),
          list: () => [],
          get: () => undefined,
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
      async hook(name, cb) {
        hooks.push({ name, cb });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, registered, hooks, transformCalls: () => transformCalls };
}

try {
  // 1. the built ESM bundle imports cleanly and default-exports the V2 definition
  const distPath = join(repoRoot, "dist", "index.js");
  if (!check("dist/index.js exists (run `npm run build` first)", existsSync(distPath), distPath)) {
    throw new Error("missing build artifact");
  }
  const mod = await import(pathToFileURL(distPath).href);
  const plugin = mod.default;
  check(
    "bundle imports; default export is the V2 plugin definition {id, setup}",
    plugin !== null && typeof plugin === "object" &&
      plugin.id === "sibyl-system" && typeof plugin.setup === "function",
    `typeof default = ${typeof plugin}, id = ${plugin && plugin.id}`,
  );
  const bundle = readFileSync(distPath, "utf8");
  check(
    "bundle carries zero @opencode runtime imports",
    !bundle.includes("@opencode-ai/") && !bundle.includes('from "@opencode/'),
    "grep @opencode over the built bundle",
  );

  // 2. invalid options -> LOUD DISABLED lines on stderr, NO tools registered
  const errLines = [];
  const realError = console.error;
  console.error = (...args) => errLines.push(args.map(String).join(" "));
  let disabled;
  try {
    disabled = fakeContext({ maxRounds: 99 }); // 99 > cap 16
    await plugin.setup(disabled.ctx);
  } finally {
    console.error = realError;
  }
  check(
    "invalid options -> DISABLED line on stderr and no tool registration",
    disabled.transformCalls() === 0 &&
      disabled.hooks.length === 0 &&
      errLines.some((l) => l.includes("SIBYL plugin DISABLED")) &&
      errLines.some((l) => l.includes("[sibyl] config error:")),
    errLines.find((l) => l.includes("config error")) ?? "no config error line",
  );

  // 3. valid minimal options -> exactly the full shipped tool surface + the
  // two law hooks (execute.before gate, context system injection)
  const live = fakeContext({
    modelPool: { default: { providerID: "smoke", modelID: "smoke" } },
  });
  const cleanup = await plugin.setup(live.ctx);
  const expected = [
    "sibyl_anchor_check",
    "sibyl_attribute",
    "sibyl_audit",
    "sibyl_consult",
    "sibyl_review",
    "sibyl_status",
    "sibyl_swarm",
    "sibyl_time_probe",
  ];
  const toolNames = live.registered.map((t) => t.name).sort().join(",");
  check(
    `valid options -> tools {${expected.join(", ")}} exactly`,
    toolNames === [...expected].sort().join(","),
    `got {${toolNames}}`,
  );
  const hookNames = live.hooks.map((h) => h.name).sort().join(",");
  check(
    "valid options -> law hooks: execute.before + context",
    hookNames === ["context", "execute.before"].sort().join(","),
    `got {${hookNames}}`,
  );
  check("setup returns a cleanup function", typeof cleanup === "function", typeof cleanup);

  // 4. sibyl_status against the fresh sandbox store -> empty listing, read-only
  const status = live.registered.find((t) => t.name === "sibyl_status");
  const out = await status.execute({}, { sessionID: "ses_smoke", signal: new AbortController().signal });
  const text = typeof out === "string" ? out : out && typeof out.content === "string" ? out.content : "";
  check(
    "sibyl_status on fresh store -> 'no sibyl runs recorded (store: …)'",
    text.startsWith("no sibyl runs recorded (store: ") && text.includes(stateFile),
    text,
  );
  check(
    "sibyl_status stayed read-only (sandbox runs file not created)",
    !existsSync(stateFile),
    existsSync(stateFile) ? "store file was written!" : "no writes",
  );
} catch (err) {
  check("smoke aborted by unexpected error", false, err instanceof Error ? err.message : String(err));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failed} check(s) failed)`);
process.exit(failed === 0 ? 0 : 1);
