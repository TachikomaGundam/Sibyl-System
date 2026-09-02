// provenance: original clean-room Sibyl-System implementation (T5 state layer),
// no external code copied. Design follows the internal Sibyl-System plan §5 and
// learnings.md #4 (default path must land in <pkg>/.state/sibyl/, cwd- and
// seam-independent) and the swarm-era crash lesson (load() NEVER throws;
// malformed entries are dropped element-by-element, never fatal).
//
// Durable run store: atomic writes (tmp+rename in the same dir),
// element-validated load, SIBYL_STATE_FILE isolation seam, and per-run
// workspace dirs under <spaceRoot>/<runId>/.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  byCreatedAt,
  compactIso,
  isNonEmptyString,
  validateEntry,
  SIBYL_STATE_FILE_ENV,
  type CreateRunInput,
  type RenameFile,
  type RunKind,
  type RunRecord,
  type RunStatus,
  type RunStoreOptions,
  type RunVerdict,
  type SaveOptions,
  type VerdictTag,
} from "./record.ts";
import { RUN_KINDS, RUN_STATUSES, VERDICT_TAGS } from "./record.ts";

export {
  SIBYL_STATE_FILE_ENV,
  RUN_KINDS,
  RUN_STATUSES,
  VERDICT_TAGS,
  type CreateRunInput,
  type RenameFile,
  type RunKind,
  type RunRecord,
  type RunStatus,
  type RunStoreOptions,
  type RunVerdict,
  type SaveOptions,
  type VerdictTag,
};

/**
 * Nearest package.json walking up from `startDir` (module file location),
 * so the default holds identically for `src/state/index.ts` imports and the
 * esbuild bundle shipped under `dist/`, and is independent of cwd.
 * Falls back to cwd only if no package.json exists up to the fs root.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const PACKAGE_ROOT: string = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_RUNS_FILE: string = join(PACKAGE_ROOT, ".state", "sibyl", "runs.json");
export const DEFAULT_SPACE_ROOT: string = join(homedir(), ".sibyl", "spaces");

function errCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
}

/** Windows: MoveFileExW(MOVEFILE_REPLACE_EXISTING) over a destination held by
 * a concurrent reader / AV scan surfaces as one of these transient codes. */
const BLOCKED_RENAME_CODES: readonly string[] = ["EPERM", "EBUSY"];

export class RunStore {
  readonly runsFile: string;
  readonly spaceRoot: string;
  /** Rename seam (see RenameFile): instance-level, defaults to fs.rename. */
  readonly renameFile: RenameFile;
  /** Serializes read-modify-write on THIS instance (lost-update guard). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts?: RunStoreOptions) {
    const envFile = process.env[SIBYL_STATE_FILE_ENV];
    this.runsFile = opts?.runsFile ?? (isNonEmptyString(envFile) ? envFile : DEFAULT_RUNS_FILE);
    this.spaceRoot = opts?.spaceRoot ?? DEFAULT_SPACE_ROOT;
    this.renameFile = opts?.rename ?? rename;
  }

  /** Never throws: missing file or corrupt JSON recovers to [] with one
   * console.error line; invalid array entries are dropped element-wise. */
  async load(): Promise<RunRecord[]> {
    let text: string;
    try {
      text = await readFile(this.runsFile, "utf8");
    } catch (err) {
      const code = errCode(err);
      if (code !== "ENOENT") {
        console.error(`[sibyl state] ${this.runsFile}: read failed (${String(code)}); treating as empty`);
      }
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error(`[sibyl state] ${this.runsFile}: corrupt JSON; treating as empty`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.error(`[sibyl state] ${this.runsFile}: root is not an array; treating as empty`);
      return [];
    }
    const records: RunRecord[] = [];
    for (const [i, raw] of parsed.entries()) {
      const v = validateEntry(raw);
      if (v.ok) records.push(v.record);
      else console.error(`[sibyl state] dropping malformed run record at index ${i}: ${v.reason}`);
    }
    return records;
  }

  /** Atomic: serialize to a unique tmp file in the SAME dir, then rename.
   * POSIX rename is atomic — a crash never leaves torn JSON. On Windows the
   * rename-over-existing-target can fail transiently (EPERM/EBUSY, see
   * BLOCKED_RENAME_CODES): unlink the destination and retry the rename once,
   * which briefly widens the crash window but never writes torn JSON. */
  async save(records: readonly RunRecord[], opts?: SaveOptions): Promise<void> {
    const dir = dirname(this.runsFile);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `runs.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const renameStep = opts?.rename ?? this.renameFile;
    try {
      await writeFile(tmp, JSON.stringify([...records], null, 2), "utf8");
      try {
        await renameStep(tmp, this.runsFile);
      } catch (err) {
        const code = errCode(err);
        if (typeof code !== "string" || !BLOCKED_RENAME_CODES.includes(code)) {
          throw err;
        }
        await unlink(this.runsFile).catch(() => undefined);
        await renameStep(tmp, this.runsFile);
      }
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /** Read-modify-write upsert, serialized per instance; the stored list
   * stays sorted by createdAt (stable — ties keep insertion order). */
  async appendOrUpdate(record: RunRecord): Promise<void> {
    const task = this.#queue.then(() => this.#appendOrUpdateInner(record));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async #appendOrUpdateInner(record: RunRecord): Promise<void> {
    const records = await this.load();
    const i = records.findIndex((r) => r.runId === record.runId);
    if (i === -1) records.push(record);
    else records[i] = record;
    records.sort(byCreatedAt);
    await this.save(records);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return (await this.load()).find((r) => r.runId === runId);
  }

  /** Creates the run record + its per-run workspace dir (status: running). */
  async createRun(input: CreateRunInput): Promise<{ record: RunRecord; spaceDir: string }> {
    const now = new Date();
    const runId = `sibyl-${compactIso(now)}-${randomBytes(2).toString("hex")}`;
    const spaceDir = join(input.spaceRootDir ?? this.spaceRoot, runId);
    await mkdir(spaceDir, { recursive: true });
    const record: RunRecord = {
      runId,
      kind: input.kind,
      artifact: input.artifact,
      status: "running",
      spaceDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (input.goal !== undefined) record.goal = input.goal;
    await this.appendOrUpdate(record);
    return { record, spaceDir };
  }
}
