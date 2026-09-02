#!/usr/bin/env node
// Sibyl-System offline smoke kit (plan task 12). Deterministic, no live LLM, no
// network, no config writes: exercises only the SHIPPED surface of the built
// bundle (import -> factory -> tool registry -> sibyl_status). The run store is
// isolated via SIBYL_STATE_FILE into a throwaway /tmp sandbox that is always
// removed; the real <repo>/.state and ~/.sibyl are never touched (no createRun,
// sibyl_status only reads).
//
// Usage: npm run build && node smoke/run-smoke.mjs
// Exit 0 = SMOKE PASS, 1 = SMOKE FAIL. One "ok"/"FAIL" line per check.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

/** Minimal structural PluginInput stand-in; the client is never called. */
const fakeInput = () => ({
  client: { session: {} },
  directory: sandbox,
  worktree: sandbox,
});

try {
  // 1. the built ESM bundle imports cleanly and default-exports the factory
  const distPath = join(repoRoot, "dist", "index.js");
  if (!check("dist/index.js exists (run `npm run build` first)", existsSync(distPath), distPath)) {
    throw new Error("missing build artifact");
  }
  const mod = await import(pathToFileURL(distPath).href);
  check(
    "bundle imports; default export is the plugin factory",
    typeof mod.default === "function",
    `typeof default = ${typeof mod.default}`,
  );

  // 2. invalid options -> empty hooks + loud DISABLED line on stderr (no throw)
  const errLines = [];
  const realError = console.error;
  console.error = (...args) => errLines.push(args.map(String).join(" "));
  let disabledHooks;
  try {
    disabledHooks = await mod.default(fakeInput(), { maxRounds: 99 }); // 99 > cap 16
  } finally {
    console.error = realError;
  }
  check(
    "invalid options -> {} and DISABLED line on stderr (never throws)",
    Object.keys(disabledHooks).length === 0 &&
      errLines.some((l) => l.includes("SIBYL plugin DISABLED")) &&
      errLines.some((l) => l.includes("[sibyl] config error:")),
    errLines.find((l) => l.includes("config error")) ?? "no config error line",
  );

  // 3. valid minimal options -> exactly the three sibyl_* tools
  const hooks = await mod.default(fakeInput(), {
    modelPool: { default: { providerID: "smoke", modelID: "smoke" } },
  });
  const toolNames = Object.keys(hooks.tool ?? {}).sort().join(",");
  check(
    "valid options -> tools {sibyl_consult, sibyl_status, sibyl_swarm} exactly",
    toolNames === "sibyl_consult,sibyl_status,sibyl_swarm",
    `got {${toolNames}}`,
  );

  // 4. sibyl_status against the fresh sandbox store -> empty listing, read-only
  const out = await hooks.tool.sibyl_status.execute(
    {},
    { directory: sandbox, abort: new AbortController().signal },
  );
  check(
    "sibyl_status on fresh store -> 'no sibyl runs recorded (store: …)'",
    typeof out === "string" &&
      out.startsWith("no sibyl runs recorded (store: ") &&
      out.includes(stateFile),
    out,
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
