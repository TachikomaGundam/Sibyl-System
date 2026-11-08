// provenance: original clean-room Sibyl-System implementation (v1.1 isolated
// lane), no external code copied. E1 runner-as-spec + L1/L4 process law.
//
// One launch = one headless `opencode run` child under a role-scoped HOME
// (HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME/OPENCODE_DB all inside
// <runDir>/<role>/home), so the human's main opencode DB receives zero
// sessions (L1; probe-proven event shape: {type,timestamp,sessionID,part}).
//
// Process law (L4): spawn is argv-only (no shell, never `bash -c`); the child
// is detached into its own process group and its pgid is recorded in a
// pidfile BEFORE the await; kills target ONLY -<pgid> from that file. There
// is deliberately no pattern-based kill anywhere in this module.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { mkdirPrivate } from "../fsperm.ts";
import { dirname, join } from "node:path";

import { type RoleProxyConfig } from "./proxy.ts";
import { resolveSeat, type SeatPolicy, type SeatPool } from "./seating.ts";

export const DEFAULT_PINNED_PATH = "/usr/bin:/bin";

export type ContainmentLevel = "hardened" | "portable";

/** Linux bubblewrap is the only filesystem-containment mechanism this package
 * implements. Other platforms may launch only through the credential relay. */
export function containmentLevel(platform: NodeJS.Platform, bwrapPresent: boolean, maskCount: number): ContainmentLevel {
  return platform === "linux" && bwrapPresent && maskCount > 0 ? "hardened" : "portable";
}

export type LaneConfig = {
  runDir: string;
  opencodeBin: string;
  configSource: string;
  /** Proxy mode: when set, the role receives a SYNTHESIZED provider-only config
   * pointing at the credential relay (src/lane/proxy.ts) and configSource is
   * NOT copied — the host config (which may carry inline apiKeys) never enters
   * the role home. Absent = today's copy-configSource semantics unchanged. */
  proxyRole?: RoleProxyConfig;
  pinnedPath?: string;
  /** exam venue (2026-10-05 leak wound: a candidate could read the grader's
   * scenario files from the shared filesystem): absolute dirs to tmpfs-mask
   * inside the candidate sandbox. Empty/undefined = unsandboxed (the venue
   * says so plainly on the voice face — no silent half-measures). */
  sandboxMaskDirs?: readonly string[];
  /** test seam: which bwrap binary to probe (default /usr/bin/bwrap) */
  bwrapBin?: string;
  /** Refuse to launch instead of falling back to the host when bwrap is unavailable. */
  requireSandbox?: boolean;
  /** Limit writable sandbox mounts to the current role rather than the whole run. */
  sandboxWriteScope?: "run" | "role";
};

/** Pure sandbox argv builder (unit-testable without spawning). The candidate
 * sees a read-only root, private process namespaces, and mask dirs emptied,
 * EXCEPT the run dir itself, rebound on top of any masked parent (dir-parent
 * first, then bind). Network remains shared so the configured model provider
 * is the only runtime egress path; agent-controlled network tools are denied. */
export function composeSandboxArgs(opts: {
  bwrapBin: string;
  maskDirs: readonly string[];
  keepDirs: readonly string[];
  bin: string;
  args: readonly string[];
}): string[] {
  const argv = [
    opts.bwrapBin,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--new-session",
    "--disable-userns",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--die-with-parent",
  ];
  for (const m of opts.maskDirs) argv.push("--tmpfs", m);
  for (const k of opts.keepDirs) argv.push("--dir", posixDirname(k), "--bind", k, k);
  argv.push("--", opts.bin, ...opts.args);
  return argv;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export type RolePaths = {
  roleDir: string;
  home: string;
  workspace: string;
  dbPath: string;
  transcript: string;
  stderrLog: string;
  promptFile: string;
  pidFile: string;
};

export function rolePaths(cfg: LaneConfig, role: string): RolePaths {
  const roleDir = join(cfg.runDir, role);
  const home = join(roleDir, "home");
  return {
    roleDir,
    home,
    workspace: join(roleDir, "workspace"),
    dbPath: join(home, ".local", "share", "opencode", "opencode.db"),
    transcript: join(roleDir, "transcript.jsonl"),
    stderrLog: join(roleDir, "stderr.log"),
    promptFile: join(roleDir, "prompt.md"),
    pidFile: join(cfg.runDir, "pids", `${role}.pid`),
  };
}

type ProviderEntry = { npm: string; options: { baseURL: string; apiKey: string }; models?: Record<string, { name: string }> };

/** Proxy-mode role config: the WHOLE provider surface — provider id, npm
 * loader, relay URL, scoped token, model catalog — so the role needs neither
 * configSource nor any host secret. The apiKey slot carries the scoped relay
 * token (revocable, quota-bound), never the provider key. */
export function synthesizeProxyConfig(p: RoleProxyConfig): { provider: Record<string, ProviderEntry> } {
  const entry: ProviderEntry = { npm: p.npm, options: { baseURL: p.relayBaseUrl, apiKey: p.roleToken } };
  if (p.models.length > 0) entry.models = Object.fromEntries(p.models.map((m) => [m, { name: m }]));
  return { provider: { [p.providerID]: entry } };
}

/** Build the minimal runtime environment for one role. Without proxy mode the
 * provider surface comes from configSource; with proxy mode it is synthesized
 * from the relay config ONLY. Host credentials and ambient proxies never cross
 * into the untrusted role process. */
export async function prepareRoleHome(
  cfg: LaneConfig,
  role: string,
): Promise<{ paths: RolePaths; env: NodeJS.ProcessEnv }> {
  const paths = rolePaths(cfg, role);
  await mkdirPrivate(join(paths.home, ".config", "opencode"));
  await mkdirPrivate(dirname(paths.dbPath));
  await mkdirPrivate(join(paths.home, ".cache", "opencode"));
  await mkdirPrivate(join(paths.home, ".local", "state", "opencode"));
  await mkdirPrivate(paths.workspace);
  await mkdirPrivate(join(cfg.runDir, "pids"));
  const roleConfigPath = join(paths.home, ".config", "opencode", "opencode.jsonc");
  if (cfg.proxyRole !== undefined) {
    // proxy mode: synthesized provider-only config; configSource is deliberately
    // NOT read. A write fault here throws (the role would run provider-less —
    // louder dead than silently mispointed, matching mkdirPrivate precedent).
    await writeFile(roleConfigPath, `${JSON.stringify(synthesizeProxyConfig(cfg.proxyRole), null, 2)}\n`, "utf8");
  } else {
    try {
      if (cfg.configSource.length > 0) {
        await copyFile(cfg.configSource, roleConfigPath);
      }
    } catch {
      // a missing config source is tolerated: the role runs on built-in defaults
    }
  }
  await writeFile(
    join(paths.workspace, "opencode.jsonc"),
    '{"tools":{"bash":false},"websearch":false,"permission":{"bash":"deny","webfetch":"deny","websearch":"deny","task":"deny","skill":"deny","question":"deny","read":"allow","edit":"allow","external_directory":"allow"}}\n',
    "utf8",
  );
  const env: NodeJS.ProcessEnv = {
    HOME: paths.home,
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_STATE_HOME: join(paths.home, ".local", "state"),
    OPENCODE_DB: paths.dbPath,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    PATH: cfg.pinnedPath ?? DEFAULT_PINNED_PATH,
    LANG: "C.UTF-8",
  };
  if (process.platform === "win32") {
    env.USERPROFILE = paths.home;
    env.APPDATA = join(paths.home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(paths.home, "AppData", "Local");
  }
  return { paths, env };
}

export type LaunchSpec = {
  title: string;
  modelId: string;
  message: string;
  resumeSession?: string;
  pure?: boolean;
  timeoutMs: number;
  /** salvage grace after timeoutMs (see options DEFAULT_ROLE_SALVAGE_GRACE_MS): the
   * deadline marks the process overdue but alive; SIGKILL only follows when the grace
   * ALSO expires. Outcomes that finish inside grace report salvagedMs. */
  salvageGraceMs?: number;
  /** per-phase suffix so multiple launches of one role keep separate
   * transcripts; the pidfile stays role-keyed (latest launch wins). */
  launchId?: string;
};

/** Pure argv builder — unit-testable without spawning. Message is passed as
 * ONE argv token; no shell ever sees it (L3/L4). */
export function composeRunArgs(spec: LaunchSpec): string[] {
  const args = ["run", "--title", spec.title, "--format", "json"];
  if (spec.pure ?? true) args.push("--pure");
  if (spec.resumeSession !== undefined) args.push("--session", spec.resumeSession);
  args.push("-m", spec.modelId);
  args.push(spec.message);
  return args;
}

export type LaunchOutcome = {
  ok: boolean;
  rc: number | null;
  signal: string | null;
  timedOut: boolean;
  paths: RolePaths;
  /** the launch-specific jsonl (suffix per launchId), not the role default. */
  transcriptPath: string;
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  error?: string;
  /** true only when the launch actually ran inside the bwrap sandbox */
  sandboxed: boolean;
  /** set when the role exceeded its deadline yet completed inside the salvage
   * grace: disclosed on the face, never hidden as an ordinary success. */
  salvagedMs?: number;
};

const SESSION_RE = /"sessionID":"(ses_[A-Za-z0-9]+)"/;

export function extractSessionId(transcriptText: string): string | null {
  const m = SESSION_RE.exec(transcriptText);
  return m ? (m[1] as string) : null;
}

/**
 * Launch one role session to completion (or kill it at timeout). Never
 * throws: spawn-level failures collapse into {ok:false, error}.
 */
export async function launchRole(cfg: LaneConfig, role: string, spec: LaunchSpec): Promise<LaunchOutcome> {
  const startedAt = new Date().toISOString();
  const paths = rolePaths(cfg, role);
  const suffix = spec.launchId === undefined || spec.launchId === "main" ? "" : `-${spec.launchId}`;
  const transcriptPath = join(paths.roleDir, `transcript${suffix}.jsonl`);
  const stderrPath = join(paths.roleDir, `stderr${suffix}.log`);
  const bwrap = cfg.bwrapBin ?? "/usr/bin/bwrap";
  const mask = cfg.sandboxMaskDirs ?? [];
  const containment = containmentLevel(process.platform, existsSync(bwrap), mask.length);
  if (cfg.requireSandbox && containment !== "hardened") {
    return {
      ok: false,
      rc: null,
      signal: null,
      timedOut: false,
      paths,
      transcriptPath,
      sessionId: null,
      startedAt,
      endedAt: new Date().toISOString(),
      error: `sandbox required; SANDBOX-UNAVAILABLE: hardened containment requires Linux bubblewrap and mask directories (platform=${process.platform}; bwrap=${bwrap})`,
      sandboxed: false,
    };
  }
  if (containment === "portable" && process.platform !== "linux" && cfg.proxyRole === undefined) {
    return {
      ok: false,
      rc: null,
      signal: null,
      timedOut: false,
      paths,
      transcriptPath,
      sessionId: null,
      startedAt,
      endedAt: new Date().toISOString(),
      error: "PORTABLE-REQUIRES-CREDENTIAL-PROXY: configure credentialProxy or run on Linux with bubblewrap",
      sandboxed: false,
    };
  }
  const { env } = await prepareRoleHome(cfg, role);
  const promptPath = join(paths.roleDir, `prompt${suffix}.md`);
  await writeFile(promptPath, spec.message, "utf8");
  await writeFile(transcriptPath, "", "utf8");
  await writeFile(stderrPath, "", "utf8");
  const args = composeRunArgs(spec);
  const sandboxed = containment === "hardened";
  const keepDirs = cfg.sandboxWriteScope === "role" ? [paths.roleDir] : [cfg.runDir];
  const spawnArgv = sandboxed
    ? composeSandboxArgs({ bwrapBin: bwrap, maskDirs: mask, keepDirs, bin: cfg.opencodeBin, args })
    : [cfg.opencodeBin, ...args];

  return new Promise<LaunchOutcome>((resolvePromise) => {
    const child = spawn(spawnArgv[0] as string, spawnArgv.slice(1), {
      cwd: paths.workspace,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, timedOut: boolean, spawnError: string | undefined): void => {
      void (async (): Promise<void> => {
        let transcript = "";
        try {
          transcript = await readFile(transcriptPath, "utf8");
        } catch {
          // empty transcript is representable by ""
        }
        const result: LaunchOutcome = {
          ok: code === 0 && !timedOut && spawnError === undefined,
          rc: code,
          signal,
          timedOut,
          paths,
          transcriptPath,
          sessionId: extractSessionId(transcript),
          startedAt,
          endedAt: new Date().toISOString(),
          sandboxed,
        };
        if (spawnError !== undefined) result.error = spawnError;
        if (deadlineHitAt !== undefined && !timedOut && code === 0) result.salvagedMs = Date.now() - deadlineHitAt;
        resolvePromise(result);
      })();
    };

    if (child.pid === undefined) {
      finish(null, null, false, `spawn failed for ${cfg.opencodeBin}`);
      return;
    }

    const pgid = child.pid;
    // pidfile is recorded right after spawn, before any kill could be asked;
    // the write racing the child's own lifetime is fine — killRole polls it.
    void writeFile(paths.pidFile, `${String(pgid)}\n`, "utf8").catch(() => undefined);

    let timedOut = false;
    let spawnError: string | undefined;
    let deadlineHitAt: number | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (): void => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pgid, "SIGKILL");
      } catch {
        // group already gone — the close event below still finalizes
      }
    };
    const tOut = child.stdout?.pipe(createWriteStream(transcriptPath, { flags: "a" }));
    const tErr = child.stderr?.pipe(createWriteStream(stderrPath, { flags: "a" }));
    const timer = setTimeout(() => {
      const grace = spec.salvageGraceMs ?? 0;
      if (grace <= 0) {
        timedOut = true;
        killGroup();
        return;
      }
      // SALVAGE phase: overdue, alive, unfinished -> wait, do not discard.
      deadlineHitAt = Date.now();
      graceTimer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, grace);
    }, spec.timeoutMs);

    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      const drain: Promise<unknown>[] = [];
      if (tOut !== undefined) drain.push(onceFinished(tOut));
      if (tErr !== undefined) drain.push(onceFinished(tErr));
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<unknown>((r) => {
        capTimer = setTimeout(r, 2_000);
      });
      void Promise.race([Promise.all(drain), cap]).then(() => {
        if (capTimer !== undefined) clearTimeout(capTimer);
        finish(code, signal ?? null, timedOut, spawnError);
      });
    });
  });
}

function onceFinished(stream: import("node:stream").Writable): Promise<unknown> {
  if (stream.writableFinished || stream.destroyed) return Promise.resolve();
  return new Promise((resolvePromise) => {
    stream.on("finish", resolvePromise);
    stream.on("error", resolvePromise);
  });
}

/**
 * L4 kill: ONLY by the numeric pgid stored in this run's pidfile. No pidfile =
 * structured failure (we never go looking for processes by name).
 */
export async function killRole(cfg: LaneConfig, role: string): Promise<{ ok: boolean; reason?: string }> {
  const pidPath = rolePaths(cfg, role).pidFile;
  let text: string;
  try {
    text = await readFile(pidPath, "utf8");
  } catch {
    return { ok: false, reason: `no pidfile for role "${role}" — refusing to search for processes` };
  }
  const pgid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return { ok: false, reason: `pidfile content is not a usable pgid: "${text.trim()}"` };
  }
  try {
    if (process.platform === "win32") process.kill(pgid, "SIGKILL");
    else process.kill(-pgid, "SIGKILL");
    return { ok: true };
  } catch (err) {
    const code = typeof err === "object" && err !== null ? String(Reflect.get(err, "code")) : "unknown";
    if (code === "ESRCH") return { ok: false, reason: `pgid ${String(pgid)} already gone` };
    return { ok: false, reason: `kill failed (${code})` };
  }
}

/** Preserve the FULL isolated session (FM-04) at MB size, not GB: fold the
 * WAL into the main db file (checkpoint TRUNCATE) BEFORE copying. The
 * sidecar can sit at hundreds of MB of recycled pages while the live content
 * is tiny — checkpointing is the honest compaction. */
export async function collectSessionDb(cfg: LaneConfig, role: string): Promise<string | null> {
  const paths = rolePaths(cfg, role);
  const target = join(paths.roleDir, "session.db");
  if (!existsSync(paths.dbPath)) return null;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("sqlite3", [paths.dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"], { timeout: 30_000, stdio: "pipe" });
  } catch {
    // no sqlite3 or a locked db: copy whatever main file exists as-is
  }
  let dbBytes: Buffer;
  try {
    dbBytes = await readFile(paths.dbPath);
  } catch {
    return null;
  }
  await writeFile(target, dbBytes);
  try {
    const walBytes = await readFile(`${paths.dbPath}-wal`);
    if (walBytes.byteLength > 0) await writeFile(`${target}-wal`, walBytes);
  } catch {
    // no wal sidecar — the main copy already carries everything
  }
  return target;
}

/** Compose + validate a launchable seat in one step, so the protocol never
 * assembles half-checked seats (E4 DENY surfaces here, before any spawn). */
export function seatOrDeny(
  role: string,
  slot: string,
  pool: SeatPool,
  policy: SeatPolicy,
): { ok: true; modelId: string } | { ok: false; deny: string } {
  const d = resolveSeat(role, slot, pool, policy);
  return d.ok ? { ok: true, modelId: d.modelId } : { ok: false, deny: d.deny };
}
