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
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveSeat, type SeatPolicy, type SeatPool } from "./seating.ts";

export const DEFAULT_PINNED_PATH = "/usr/bin:/bin";

export type LaneConfig = {
  runDir: string;
  opencodeBin: string;
  configSource: string;
  pinnedPath?: string;
};

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

/** Build the pinned env for one role (L1). Inherited env keeps provider
 * wiring working; only the isolation-critical vars are overridden. */
export async function prepareRoleHome(
  cfg: LaneConfig,
  role: string,
): Promise<{ paths: RolePaths; env: NodeJS.ProcessEnv }> {
  const paths = rolePaths(cfg, role);
  await mkdir(join(paths.home, ".config", "opencode"), { recursive: true });
  await mkdir(dirname(paths.dbPath), { recursive: true });
  await mkdir(join(paths.home, ".cache", "opencode"), { recursive: true });
  await mkdir(join(paths.home, ".local", "state", "opencode"), { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(join(cfg.runDir, "pids"), { recursive: true });
  try {
    if (cfg.configSource.length > 0) {
      await copyFile(cfg.configSource, join(paths.home, ".config", "opencode", "opencode.jsonc"));
    }
  } catch {
    // a missing config source is tolerated: the role runs on built-in defaults
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: paths.home,
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_STATE_HOME: join(paths.home, ".local", "state"),
    OPENCODE_DB: paths.dbPath,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    PATH: cfg.pinnedPath ?? DEFAULT_PINNED_PATH,
  };
  return { paths, env };
}

export type LaunchSpec = {
  title: string;
  modelId: string;
  message: string;
  resumeSession?: string;
  pure?: boolean;
  timeoutMs: number;
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
  const { paths, env } = await prepareRoleHome(cfg, role);
  const suffix = spec.launchId === undefined || spec.launchId === "main" ? "" : `-${spec.launchId}`;
  const transcriptPath = join(paths.roleDir, `transcript${suffix}.jsonl`);
  const stderrPath = join(paths.roleDir, `stderr${suffix}.log`);
  const promptPath = join(paths.roleDir, `prompt${suffix}.md`);
  await writeFile(promptPath, spec.message, "utf8");
  await writeFile(transcriptPath, "", "utf8");
  await writeFile(stderrPath, "", "utf8");
  const args = composeRunArgs(spec);

  return new Promise<LaunchOutcome>((resolvePromise) => {
    const child = spawn(cfg.opencodeBin, args, {
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
        };
        if (spawnError !== undefined) result.error = spawnError;
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
    const tOut = child.stdout?.pipe(createWriteStream(transcriptPath, { flags: "a" }));
    const tErr = child.stderr?.pipe(createWriteStream(stderrPath, { flags: "a" }));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // group already gone — the close event below still finalizes
      }
    }, spec.timeoutMs);

    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
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
    process.kill(-pgid, "SIGKILL");
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
