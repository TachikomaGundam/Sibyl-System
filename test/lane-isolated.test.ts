// provenance: v1.1 isolated-lane tests. The stub binary asserts HOME pinning
// ITSELF (L1 proof at the child's own eyes), leaves a PARTIAL artifact before
// sleeping (L5), and is only ever killed via the recorded pidfile (L4/A2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  binProtectionArgv,
  collectSessionDb,
  composeRunArgs,
  composeSandboxArgs,
  resolveLaneBin,
  extractSessionId,
  killRole,
  launchRole,
  prepareRoleHome,
  rolePaths,
  seatOrDeny,
  symlinkChain,
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

// --- lane-spawn wound 20261108: masks covering the bin must never kill execvp -------

test("binProtectionArgv: wound shape — /home mask + symlinked npm-global bin rebinds both parents read-only", () => {
  const argv = binProtectionArgv({
    maskDirs: ["/home"],
    hops: ["/home/you/.npm-global/bin/opencode", "/home/you/.npm-global/lib/node_modules/opencode-ai/bin/opencode.exe"],
  });
  assert.deepEqual(argv, [
    "--dir", "/home/you",
    "--dir", "/home/you/.npm-global",
    "--dir", "/home/you/.npm-global/lib",
    "--dir", "/home/you/.npm-global/lib/node_modules",
    "--dir", "/home/you/.npm-global/lib/node_modules/opencode-ai",
    "--ro-bind", "/home/you/.npm-global/bin", "/home/you/.npm-global/bin",
    "--ro-bind", "/home/you/.npm-global/lib/node_modules/opencode-ai/bin", "/home/you/.npm-global/lib/node_modules/opencode-ai/bin",
  ]);
});

test("binProtectionArgv: multi-hop chain rebinds EVERY hop — an intermediate symlink must not dangle", () => {
  const argv = binProtectionArgv({
    maskDirs: ["/home"],
    hops: [
      "/home/you/.local/bin/opencode",
      "/home/you/.npm-global/bin/opencode",
      "/home/you/.npm-global/lib/node_modules/opencode-ai/bin/opencode.exe",
    ],
  });
  assert.deepEqual(argv, [
    "--dir", "/home/you",
    "--dir", "/home/you/.local",
    "--dir", "/home/you/.npm-global",
    "--dir", "/home/you/.npm-global/lib",
    "--dir", "/home/you/.npm-global/lib/node_modules",
    "--dir", "/home/you/.npm-global/lib/node_modules/opencode-ai",
    "--ro-bind", "/home/you/.local/bin", "/home/you/.local/bin",
    "--ro-bind", "/home/you/.npm-global/bin", "/home/you/.npm-global/bin",
    "--ro-bind", "/home/you/.npm-global/lib/node_modules/opencode-ai/bin", "/home/you/.npm-global/lib/node_modules/opencode-ai/bin",
  ]);
});

test("binProtectionArgv: bin outside every mask -> zero tokens", () => {
  assert.deepEqual(binProtectionArgv({ maskDirs: ["/home"], hops: ["/usr/local/bin/opencode"] }), []);
});

test("binProtectionArgv: mask matching is path-segment bounded (/home never hits /homepage)", () => {
  assert.deepEqual(binProtectionArgv({ maskDirs: ["/home"], hops: ["/homepage/x/oc"] }), []);
});

test("binProtectionArgv: a hop outside the mask protects nothing on its own", () => {
  const argv = binProtectionArgv({ maskDirs: ["/home"], hops: ["/home/u/bin/oc", "/opt/oc/exe"] });
  assert.deepEqual(argv, ["--dir", "/home/u", "--ro-bind", "/home/u/bin", "/home/u/bin"]);
});

test("binProtectionArgv: bin hanging directly on the masking root binds the FILE, never the root", () => {
  const argv = binProtectionArgv({ maskDirs: ["/data"], hops: ["/data/tool", "/data/store/tool.bin"] });
  assert.deepEqual(argv, ["--ro-bind", "/data/tool", "/data/tool", "--ro-bind", "/data/store", "/data/store"]);
});

test("binProtectionArgv: deeper target inside an already-bound subtree is not re-bound", () => {
  const argv = binProtectionArgv({ maskDirs: ["/srv"], hops: ["/srv/tools/bin/oc", "/srv/tools/bin/oc.real"] });
  assert.deepEqual(argv, ["--dir", "/srv/tools", "--ro-bind", "/srv/tools/bin", "/srv/tools/bin"]);
});

test("symlinkChain: regular file=[itself]; relative+absolute hops chased; dangling stops; cycles bounded", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-chain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = join(dir, "real.bin");
  await writeFile(real, "#!/bin/sh\n", "utf8");
  const rel = join(dir, "rel");
  await symlink("real.bin", rel);
  const abs = join(dir, "abs");
  await symlink(rel, abs);
  assert.deepEqual(symlinkChain(real), [real]);
  assert.deepEqual(symlinkChain(rel), [rel, real]);
  assert.deepEqual(symlinkChain(abs), [abs, rel, real]);
  const dangler = join(dir, "dangler");
  await symlink("no-such-target", dangler);
  assert.deepEqual(symlinkChain(dangler), [dangler, join(dir, "no-such-target")], "dangling chain stops at the missing hop");
  const a = join(dir, "loop-a");
  const b = join(dir, "loop-b");
  await symlink(b, a);
  await symlink(a, b);
  assert.ok(symlinkChain(a, 5).length <= 6, "cycle bounded by maxHops, never infinite");
});

test("composeSandboxArgs: bin protection lands after every tmpfs mask and before the writable keeps", () => {
  const argv = composeSandboxArgs({
    bwrapBin: "/usr/bin/bwrap",
    maskDirs: ["/home"],
    keepDirs: ["/tmp/sibyl-run-y"],
    bin: "/home/u/.npm-global/bin/opencode",
    binChain: ["/home/u/.npm-global/bin/opencode", "/home/u/.npm-global/lib/node_modules/oc/bin/oc.exe"],
    args: ["run"],
  });
  const lastTmpfs = argv.map((t, i) => [t, i] as const).filter(([t]) => t === "--tmpfs").map(([, i]) => i).pop() as number;
  const firstRoBind = argv.indexOf("--ro-bind", argv.indexOf("--dev"));
  const keepBind = argv.indexOf("--bind");
  assert.ok(lastTmpfs < firstRoBind, "protection rebinds on top of the tmpfs mask");
  assert.ok(firstRoBind < keepBind, "writable keeps still come last");
  assert.ok(argv.includes("/home/u/.npm-global/bin"), "bin parent re-exposed read-only");
  assert.equal(argv.filter((t) => t === "--bind").length, 1, "only the keep dir keeps its writable bind");
});

test("resolveLaneBin: bare names resolve host-side on PATH; absolute paths and misses pass through", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-resolvebin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hit = join(dir, "oc");
  await writeFile(hit, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(hit, 0o755);
  const decoy = join(dir, "oc-decoy");
  await writeFile(decoy, "not executable", "utf8");
  assert.equal(resolveLaneBin("/abs/bin/oc", `${dir}:/usr/bin`), "/abs/bin/oc", "absolute spec untouched");
  assert.equal(resolveLaneBin("oc", `/nonexistent:${dir}:/usr/bin`), hit, "first executable PATH hit wins");
  assert.equal(resolveLaneBin("oc-decoy", dir), "oc-decoy", "non-executable is skipped, name passes through");
  assert.equal(resolveLaneBin("no-such-bin-xyz", `${dir}:/usr/bin`), "no-such-bin-xyz", "miss passes through to fail loud, named at spawn");
  assert.equal(resolveLaneBin("", dir), "");
});

test("launchRole + real bwrap: a bin living INSIDE the masked dir still execs (wound 20261108 end-to-end)", { skip: existsSync("/usr/bin/bwrap") ? false : "needs bubblewrap" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sibyl-wound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeHome = join(root, "fakehome");
  const binDir = join(fakeHome, ".npm-global", "bin");
  const pkgDir = join(fakeHome, ".npm-global", "lib", "node_modules", "oc", "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(pkgDir, { recursive: true });
  const real = join(pkgDir, "oc.exe");
  await writeFile(real, '#!/bin/sh\nprintf \'{"type":"text","sessionID":"ses_wound12345","part":{"type":"text","text":"ok"}}\\n\'\nexit 0\n', "utf8");
  await chmod(real, 0o755);
  await symlink("../lib/node_modules/oc/bin/oc.exe", join(binDir, "opencode"));
  const out = await launchRole(
    {
      runDir: join(root, "run"),
      opencodeBin: join(binDir, "opencode"),
      configSource: "",
      sandboxMaskDirs: [fakeHome],
      requireSandbox: true,
    },
    "evidence",
    { title: "x", modelId: "p/m", message: "hi", timeoutMs: 15_000, launchId: "w1" },
  );
  assert.equal(out.sandboxed, true, "hardened sandbox actually ran");
  assert.equal(out.ok, true, `bin under the mask must exec, got rc=${String(out.rc)} err=${out.error ?? ""}`);
  assert.equal(out.sessionId, "ses_wound12345", "the rebound bin produced its transcript");
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
