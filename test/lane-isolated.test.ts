// provenance: v1.1 isolated-lane tests. The stub binary asserts HOME pinning
// ITSELF (L1 proof at the child's own eyes), leaves a PARTIAL artifact before
// sleeping (L5), and is only ever killed via the recorded pidfile (L4/A2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectSessionDb,
  composeRunArgs,
  composeSandboxArgs,
  extractSessionId,
  killRole,
  launchRole,
  prepareRoleHome,
  rolePaths,
  seatOrDeny,
  type LaneConfig,
} from "../src/lane/isolated.ts";

const STUB = `#!/bin/sh
# sibyl lane test stub
case "$HOME" in
  */sibyl-lane-*/*) : ;;
  *) echo "stub: HOME not under run dir: $HOME" >&2; exit 7 ;;
esac
printf '{"type":"step_start","timestamp":1,"sessionID":"ses_stub12345","part":{"type":"step-start"}}\\n'
printf '## section\\npartial-before-sleep\\n' > "$HOME/../draft.md"
printf '{"type":"text","timestamp":2,"sessionID":"ses_stub12345","part":{"type":"text","text":"hello"}}\\n'
case "$*" in
  *sleep-30*) sleep 30 ;;
  *sleep-1*) sleep 1 ;;
esac
if [ -n "$STUB_MAKE_DB" ]; then printf 'dbbytes' > "$OPENCODE_DB"; fi
exit 0
`;

async function fixture(t: { after: (fn: () => unknown) => void }, label: string): Promise<LaneConfig & { dir: string; stub: string }> {
  const dir = await mkdtemp(join(tmpdir(), `sibyl-lane-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = join(dir, "stub-opencode.sh");
  await writeFile(stub, STUB, "utf8");
  await chmod(stub, 0o755);
  return { dir, stub, runDir: join(dir, "run"), opencodeBin: stub, configSource: join(dir, "config.jsonc") };
}

test("composeRunArgs: exact argv — run/--title/--format json/--pure/-m + single message token", () => {
  const a = composeRunArgs({ title: "sibyl-r1-pro", modelId: "local-qwen/m", message: "multi\nline $prompt `tick`", timeoutMs: 1000 });
  assert.deepEqual(a, ["run", "--title", "sibyl-r1-pro", "--format", "json", "--pure", "-m", "local-qwen/m", "multi\nline $prompt `tick`"]);
});

test("composeRunArgs: resume adds --session; pure:false omits --pure", () => {
  const a = composeRunArgs({ title: "t", modelId: "p/m", message: "x", resumeSession: "ses_abc", pure: false, timeoutMs: 1000 });
  assert.deepEqual(a, ["run", "--title", "t", "--format", "json", "--session", "ses_abc", "-m", "p/m", "x"]);
});

test("extractSessionId: first ses_ id wins; absent is null", () => {
  assert.equal(extractSessionId('{"sessionID":"ses_x1"}\n{"sessionID":"ses_x2"}'), "ses_x1");
  assert.equal(extractSessionId("no ids here"), null);
});

test("prepareRoleHome: dirs + copied config + pinned env (L1 shape)", async (t) => {
  const cfg = await fixture(t, "prep");
  process.env.SIBYL_TEST_SECRET_CANARY = "must-not-reach-role";
  t.after(() => delete process.env.SIBYL_TEST_SECRET_CANARY);
  await writeFile(cfg.configSource, '{"provider":{}}\n', "utf8");
  const { paths, env } = await prepareRoleHome(cfg, "pro");
  assert.ok(existsSync(paths.workspace));
  assert.equal(env.HOME, paths.home);
  assert.equal(env.OPENCODE_DB, paths.dbPath);
  assert.equal(env.OPENCODE_DB?.startsWith(join(cfg.runDir, "pro")), true, "db path is inside the run dir");
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.SIBYL_TEST_SECRET_CANARY, undefined, "host secrets never reach a role process");
  const copied = await readFile(join(paths.home, ".config", "opencode", "opencode.jsonc"), "utf8");
  assert.match(copied, /provider/);
  // missing config source stays tolerated
  const cfg2 = { ...cfg, configSource: join(cfg.dir, "absent.jsonc"), runDir: join(cfg.dir, "run2") };
  const r2 = await prepareRoleHome(cfg2, "con");
  assert.ok(existsSync(r2.paths.home));
});

test("prepareRoleHome: role workspace denies bash despite a permissive host config", async (t) => {
  const cfg = await fixture(t, "tool-policy");
  await writeFile(cfg.configSource, '{"permission":{"bash":"allow"},"provider":{}}\n', "utf8");

  const { paths } = await prepareRoleHome(cfg, "evidence");
  const overlay = JSON.parse(await readFile(join(paths.workspace, "opencode.jsonc"), "utf8")) as {
    permission: { bash: string };
  };
  assert.equal(overlay.permission.bash, "deny");
});

test("launchRole end-to-end with stub env: transcript, sessionId, rc=0, config copy, db collect", async (t) => {
  const cfg = await fixture(t, "e2e");
  const outcome = await launchRole(cfg, "pro", {
    title: "sibyl-test-pro",
    modelId: "local-qwen/m",
    message: "go",
    timeoutMs: 15_000,
  });
  assert.ok(outcome.ok, JSON.stringify({ rc: outcome.rc, err: outcome.error }));
  assert.equal(outcome.rc, 0);
  assert.equal(outcome.sessionId, "ses_stub12345");
  const transcript = await readFile(outcome.paths.transcript, "utf8");
  assert.match(transcript, /"sessionID":"ses_stub12345"/);
  assert.equal(await readFile(outcome.paths.pidFile, "utf8").then((s) => /^\d+\n$/.test(s)), true, "pidfile numeric");
  const db = await collectSessionDb(cfg, "pro");
  assert.equal(db, null, "stub made no db -> collection is honest about absence");
});

test("launchRole: timeout kills the whole group; PARTIAL artifact survives (L5/L6 inputs)", async (t) => {
  const cfg = await fixture(t, "timeout");
  const art = join(cfg.runDir, "con", "draft.md");
  const t0 = Date.now();
  const outcome = await launchRole(cfg, "con", {
    title: "sibyl-test-con-sleep-30",
    modelId: "local-qwen/m",
    message: "go",
    timeoutMs: 1_500,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10_000, `kill must be prompt, took ${String(elapsed)}ms`);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
  const partial = await readFile(art, "utf8");
  assert.match(partial, /partial-before-sleep/, "dead member's artifact stays judge-usable (L5)");
});

test("killRole: pidfile-only kill; missing pidfile is a refusal, never a search", async (t) => {
  const cfg = await fixture(t, "kill");
  const noPid = await killRole(cfg, "judge");
  assert.ok(!noPid.ok);
  assert.match(noPid.reason ?? "", /refusing to search/);

  const running = launchRole(cfg, "judge", {
    title: "sibyl-test-judge-sleep-30",
    modelId: "local-qwen/m",
    message: "go",
    timeoutMs: 60_000,
  });
  // wait for the pidfile to appear (launch writes it right after spawn)
  const pidPath = rolePaths(cfg, "judge").pidFile;
  for (let i = 0; i < 100 && !existsSync(pidPath); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const killed = await killRole(cfg, "judge");
  assert.ok(killed.ok, JSON.stringify(killed));
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, false, "explicit kill is distinguishable from timeout");
  assert.match(String(outcome.signal ?? ""), /SIG(KILL|TERM)/);
});

test("seatOrDeny: cloud seat denies before any spawn machinery is reached", () => {
  const pool = { default: { providerID: "openai", modelID: "gpt-x" } };
  const d = seatOrDeny("pro", "default", pool, { allowedPrefixes: ["local-"] });
  assert.ok(!d.ok);
  assert.match(d.deny, /modelPolicy/);
});

// --- exam venue sandbox (2026-10-05 grader-leak wound fix) ---------------------

test("composeSandboxArgs: ro root, dev, tmpfs masks, then keep rebinds (dir-parent first), then -- and the inner argv", () => {
  const argv = composeSandboxArgs({
    bwrapBin: "/usr/bin/bwrap",
    maskDirs: ["/home/me/workspace", "/tmp"],
    keepDirs: ["/tmp/sibyl-run-x"],
    bin: "/abs/opencode",
    args: ["run", "--title", "t"],
  });
  assert.equal(argv[0], "/usr/bin/bwrap");
  const j = (tok: string): number => argv.indexOf(tok);
  assert.ok(j("--ro-bind") < j("--dev"), "root read-only before anything");
  assert.ok(j("--unshare-user") < j("--ro-bind"), "sandbox has a separate user namespace");
  assert.ok(j("--unshare-pid") < j("--proc"), "sandbox has a private pid namespace and procfs");
  assert.equal(j("--unshare-net"), -1, "model roles retain the configured provider network path");
  assert.ok(j("--tmpfs") < j("--dir"), "masks applied before keeps");
  const keep = j("--dir");
  assert.equal(argv[keep], "--dir");
  assert.equal(argv[keep + 1], "/tmp");
  assert.equal(argv[keep + 2], "--bind");
  assert.equal(argv[keep + 3], "/tmp/sibyl-run-x");
  assert.ok(j("--") < argv.indexOf("/abs/opencode"));
  assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["/abs/opencode", "run", "--title", "t"]);
});

test("launchRole sandbox preflight: missing bwrap falls back to direct spawn and SAYS sandboxed=false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-sbx-fallback-"));
  const cfg: LaneConfig = {
    runDir: dir,
    opencodeBin: "/bin/true",
    configSource: "",
    sandboxMaskDirs: ["/some/where"],
    bwrapBin: join(dir, "no-such-bwrap"),
  };
  const out = await launchRole(cfg, "candidate", { title: "x", modelId: "p/m", message: "hi", timeoutMs: 5_000, launchId: "t1" });
  assert.equal(out.sandboxed, false, "no bwrap -> honest unsandboxed flag");
  assert.equal(out.ok, true, out.error ?? "");
  assert.equal(out.rc, 0);
});

test("launchRole: required sandbox refuses without spawning when bwrap is absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-sbx-required-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, "spawned");
  const stub = join(dir, "should-not-run.sh");
  await writeFile(stub, `#!/bin/sh\nprintf spawned > ${marker}\n`, "utf8");
  await chmod(stub, 0o755);
  const out = await launchRole(
    {
      runDir: join(dir, "run"),
      opencodeBin: stub,
      configSource: "",
      sandboxMaskDirs: ["/some/where"],
      bwrapBin: join(dir, "no-such-bwrap"),
      requireSandbox: true,
    },
    "evidence",
    { title: "x", modelId: "p/m", message: "hi", timeoutMs: 5_000 },
  );
  assert.equal(out.ok, false);
  assert.equal(out.sandboxed, false);
  assert.match(out.error ?? "", /sandbox required.*bwrap/i);
  assert.equal(existsSync(marker), false);
});

// --- SALVAGE grace (wound 20261104): deadline passes but the work completes -> keep it.
//     Grace also exhausted -> SIGKILL and timedOut stay loud. Fail-closed unchanged.

test("salvage: role finishing after its deadline inside grace is KEPT and disclosed", async (t) => {
  const fx = await fixture(t, "salvage-keep");
  const outcome = await launchRole(
    { runDir: fx.dir, opencodeBin: fx.stub, configSource: "" },
    "pro",
    { title: "sleep-1", modelId: "p/m", message: "go", timeoutMs: 400, salvageGraceMs: 8_000 },
  );
  // (stub sleeps 1s > 400ms deadline, < 8s grace, exits 0)
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.ok, true);
  assert.ok(typeof outcome.salvagedMs === "number" && outcome.salvagedMs >= 300);
});

test("salvage: grace exhausted still kills loudly with timedOut=true", async (t) => {
  const fx = await fixture(t, "salvage-kill");
  const outcome = await launchRole(
    { runDir: fx.dir, opencodeBin: fx.stub, configSource: "" },
    "con",
    { title: "sleep-30", modelId: "p/m", message: "go", timeoutMs: 300, salvageGraceMs: 400 },
  );
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.salvagedMs, undefined);
});
