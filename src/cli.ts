// provenance: original clean-room Sibyl-System implementation (v1.1 CLI).
// E1: the isolated runner promoted to a first-class launcher IN THIS REPO —
// the proven /tmp-sandbox pattern is now the production lane, not a bench
// script. E5: visibility is sibyl-chamber status + spotcheck (named sessions
// live in the ISOLATED db; the human's main session list stays clean).
//
// Subcommands:
//   run  --target <path|-> --goal <text> [--profile review|exam]
//        [--scenario <file> ...] [--seed <hex>] [--max-rounds n]
//        [--model <provider/model>] [--judge-pool <ids,comma>] [--config <json>]
//        [--kill-role <r> --kill-after <ms>] [--opencode-bin <path> --config-source <jsonc>] [--detach]
//   status [--run-id <id>] [--tail n]        (E5 record view)
//   spotcheck <runDir|runId>                 (A4 one-command verification)
//   kill <runDir> <role>                     (L4 pidfile-only)
//
// Single-voice law: `run` prints EXACTLY the renderVoice block (review) or the
// exam equivalent — never raw debate output.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { compactIso } from "./state/record.ts";
import { instrumentFace } from "./instrument.ts";
import { DEFAULT_CHAMBER_LEDGER, loadLedger, spotcheckCommand, type ChamberRecord } from "./state/chamber.ts";
import { buildVoice, renderVoice } from "./chamber/synthesis.ts";
import { runChamber, type ChamberConfig, type ChamberRole, type Lane, type LaunchFacts } from "./chamber/protocol.ts";
import { launchRole, collectSessionDb, killRole, type LaneConfig } from "./lane/isolated.ts";
import { parseScenario, type ScenarioSpec } from "./exam/scenario.ts";
import { runExamScenario, type CandidateDriver, type ExamResult } from "./exam/runner.ts";
import { runBell } from "./exam/bell.ts";
import { parseOptions, type PluginOptions } from "./options.ts";

export type CliFlags = Record<string, string | boolean>;

const BOOLEAN_FLAGS: readonly string[] = ["detach", "help"];

export function parseCliArgs(argv: readonly string[]): { cmd: string; flags: CliFlags; rest: string[] } {
  const cmd = argv[0] ?? "help";
  const flags: CliFlags = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith("--") && !BOOLEAN_FLAGS.includes(name)) {
          flags[tok.slice(2)] = nxt;
          i += 1;
        } else flags[tok.slice(2)] = true;
      }
    } else rest.push(tok);
  }
  return { cmd, flags, rest };
}

export function splitModelId(modelId: string): { providerID: string; modelID: string } | null {
  const i = modelId.indexOf("/");
  if (i <= 0 || i === modelId.length - 1) return null;
  return { providerID: modelId.slice(0, i), modelID: modelId.slice(i + 1) };
}

export type LaneBase = { opencodeBin: string; configSource: string; runRoot: string };

export type ResolvedRun = {
  runId: string;
  runDir: string;
  laneCfg: LaneBase;
  timeoutMs: number;
  chamber: ChamberConfig | null;
  exam: { scenarios: ScenarioSpec[]; modelId: string } | null;
  killInjection: { role: ChamberRole; afterMs: number } | null;
};

/** Build every run parameter from flags + (optional) plugin-options config
 * file, applying E4 policy at seat resolution. Pure-ish: only fs reads. */
export async function resolveRun(flags: CliFlags): Promise<{ ok: true; run: ResolvedRun } | { ok: false; error: string }> {
  let opts: PluginOptions | null = null;
  if (typeof flags["config"] === "string") {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(flags["config"], "utf8"));
    } catch (e) {
      return { ok: false, error: `--config unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
    const parsed = parseOptions(raw);
    if (!parsed.ok) return { ok: false, error: `--config invalid: ${parsed.errors.join("; ")}` };
    opts = parsed.options;
  }
  const laneCfg: LaneBase = {
    runRoot: typeof flags["run-root"] === "string" ? flags["run-root"] : opts?.lane.runRoot ?? "/tmp",
    // empty bin crashed spawn with ERR_INVALID_ARG_VALUE (exam-venue injury, 2026-10-03);
    // resolution order: flag -> config -> env -> PATH name (spawn resolves bare names).
    opencodeBin:
      typeof flags["opencode-bin"] === "string" ? flags["opencode-bin"]
      : (opts?.lane.opencodeBin ?? "").length > 0 ? (opts as { lane: { opencodeBin: string } }).lane.opencodeBin
      : (process.env["OPENCODE_BIN"] ?? "").length > 0 ? (process.env["OPENCODE_BIN"] as string)
      : "opencode",
    configSource:
      typeof flags["config-source"] === "string" ? flags["config-source"] : opts?.lane.configSource ?? "",
  };
  const modelFlag = typeof flags["model"] === "string" ? flags["model"] : null;
  const pool = opts?.modelPool ?? { default: { providerID: "", modelID: "" } };
  if (modelFlag !== null && splitModelId(modelFlag) === null) {
    return { ok: false, error: `--model must be provider/model, got "${modelFlag}"` };
  }
  const effectivePool =
    modelFlag === null
      ? pool
      : { ...pool, default: splitModelId(modelFlag) as { providerID: string; modelID: string } };
  const policy = opts?.modelPolicy ?? { allowedPrefixes: ["local-"] };
  const seed = typeof flags["seed"] === "string" ? flags["seed"] : randomBytes(8).toString("hex");
  const maxRounds = typeof flags["max-rounds"] === "string" ? Number(flags["max-rounds"]) : opts?.chamber.maxRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) return { ok: false, error: `--max-rounds must be 1..8` };

  const goal = typeof flags["goal"] === "string" ? flags["goal"] : null;
  if (goal === null) return { ok: false, error: "--goal is required" };
  const targetRaw = typeof flags["target"] === "string" ? flags["target"] : null;
  if (targetRaw === null) return { ok: false, error: "--target is required (path, or '-' for exam profile)" };

  const judgeSlotNames = Array.isArray(opts?.chamber.judgePool) ? opts.chamber.judgePool : ["default"];
  const judgePoolIds = [...new Set(judgeSlotNames.map((slot) => slotToId(slot, effectivePool)))].filter((x): x is string => x !== null);
  if (typeof flags["judge-pool"] === "string") {
    judgePoolIds.length = 0;
    judgePoolIds.push(...flags["judge-pool"].split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }

  const now = new Date();
  const runId = `sibyl-${compactIso(now)}-${randomBytes(2).toString("hex")}`;
  const runDir = join(laneCfg.runRoot, `sibyl-run-${runId}`);
  await mkdir(runDir, { recursive: true });

  let targetPath = targetRaw;
  if (targetRaw !== "-") {
    const abs = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);
    targetPath = join(runDir, "target", basename(abs));
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await copyFile(abs, targetPath);
    } catch (e) {
      return { ok: false, error: `--target unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const profile = typeof flags["profile"] === "string" ? flags["profile"] : "review";
  let killInjection: ResolvedRun["killInjection"] = null;
  if (typeof flags["kill-role"] === "string" && typeof flags["kill-after"] === "string") {
    if (!["evidence", "pro", "con", "judge"].includes(flags["kill-role"])) return { ok: false, error: `--kill-role invalid` };
    const afterMs = Number(flags["kill-after"]);
    if (!Number.isFinite(afterMs) || afterMs < 0) return { ok: false, error: `--kill-after must be ms` };
    killInjection = { role: flags["kill-role"] as ChamberRole, afterMs };
  }

  const timeoutMs = opts?.lane.roleTimeoutMs ?? 600_000;
  if (profile === "exam") {
    const scenarioPaths = flags["scenario"];
    const list = typeof scenarioPaths === "string" ? [scenarioPaths] : [];
    const scenarios: ScenarioSpec[] = [];
    for (const p of list) {
      const v = parseScenario(await readFile(p, "utf8"));
      if (!v.ok) return { ok: false, error: `scenario ${p}: ${v.errors.join("; ")}` };
      scenarios.push(v.scenario as ScenarioSpec);
    }
    if (scenarios.length === 0) return { ok: false, error: "--profile exam needs at least one --scenario" };
    const only = splitModelId(modelFlag ?? "") ?? null;
    if (only === null) return { ok: false, error: "--profile exam requires --model provider/model" };
    return { ok: true, run: { runId, runDir, laneCfg, timeoutMs, chamber: null, exam: { scenarios, modelId: modelFlag as string }, killInjection } };
  }
  if (profile !== "review") return { ok: false, error: `unknown --profile ${profile}` };

  const slots: Record<ChamberRole, string> = {
    evidence: opts?.chamber.roles.evidence ?? "default",
    pro: opts?.chamber.roles.pro ?? "default",
    con: opts?.chamber.roles.con ?? "default",
    judge: opts?.chamber.roles.judge ?? "default",
  };
  if (modelFlag !== null) {
    slots.evidence = "default";
    slots.pro = "default";
    slots.con = "default";
    slots.judge = "default";
  }
  const chamber: ChamberConfig = {
    runId,
    runDir,
    goal,
    targetPath,
    ledgerPath: DEFAULT_CHAMBER_LEDGER,
    seed,
    maxRounds,
    pool: effectivePool,
    policy,
    instrument: instrumentFace(),
    slots,
    judgePoolIds: judgePoolIds.length > 0 ? judgePoolIds : [...new Set(judgeSlotNames.map((s) => slotToId(s, effectivePool)).filter((x): x is string => x !== null))],
    lane: null as unknown as Lane, // wired below (type seam: lane needs cfg, cfg needs lane)
  };
  chamber.lane = makeIsolatedLane(chamber, laneCfg, timeoutMs);
  return { ok: true, run: { runId, runDir, laneCfg, timeoutMs, chamber, exam: null, killInjection } };
}

function slotToId(slot: string, pool: Record<string, { providerID: string; modelID: string }>): string | null {
  const m = pool[slot] ?? pool["default"];
  if (m === undefined || m.providerID.length === 0 || m.modelID.length === 0) return null;
  return `${m.providerID}/${m.modelID}`;
}

function makeIsolatedLane(cfg: ChamberConfig, laneCfg: LaneBase, timeoutMs: number): Lane {
  return {
    async launch(req: { role: string; title: string; modelId: string; message: string; launchId: string }): Promise<LaunchFacts> {
      const model = splitModelId(req.modelId);
      if (model === null) return { ok: false, rc: null, signal: null, timedOut: false };
      const outcome = await launchRole(
        { runDir: cfg.runDir, opencodeBin: laneCfg.opencodeBin, configSource: laneCfg.configSource },
        req.role,
        { title: req.title, modelId: req.modelId, message: req.message, launchId: req.launchId, timeoutMs, pure: true },
      );
      return { ok: outcome.ok, rc: outcome.rc, signal: outcome.signal, timedOut: outcome.timedOut };
    },
    async kill(role: string): Promise<{ ok: boolean; reason?: string }> {
      return await killRole({ runDir: cfg.runDir, opencodeBin: laneCfg.opencodeBin, configSource: laneCfg.configSource }, role);
    },
  };
}

function makeExamDriver(laneCfgBase: LaneBase, runDir: string, modelId: string, timeoutMs: number): CandidateDriver {
  const lc: LaneConfig = { runDir, opencodeBin: laneCfgBase.opencodeBin, configSource: laneCfgBase.configSource };
  let turnNo = 0;
  const run = async (message: string, resume?: string) => {
    turnNo += 1;
    const o = await launchRole(lc, "candidate", {
      title: `sibyl-exam-candidate-t${String(turnNo)}`,
      modelId,
      message,
      launchId: `t${String(turnNo)}`,
      timeoutMs,
      pure: true,
      ...(resume !== undefined && { resumeSession: resume }),
    });
    const transcript = await readFile(o.transcriptPath, "utf8").catch(() => "");
    return { facts: { ok: o.ok, rc: o.rc, signal: o.signal, timedOut: o.timedOut }, transcript, sessionId: o.sessionId };
  };
  return {
    start: async (prompt) => await run(prompt),
    continueTurn: async (sid, message) => await run(message, sid),
  };
}

export function examVoice(results: ExamResult[], runId: string, runDir: string): string {
  const lines = ["SIBYL — ONE CONCLUSION, ONE VOICE  [SIBYL-ONE-VOICE]"];
  let anyFail = false;
  let anyHuman = false;
  for (const r of results) {
    if (r.grade.verdict === "FAIL") anyFail = true;
    if (r.grade.verdict === "NEEDS_HUMAN" || r.infraGaps.length > 0) anyHuman = true;
    lines.push(`${r.scenarioId}: ${r.grade.verdict}${r.veto ? " CANARY-VETO" : ""}`);
    for (const o of r.grade.outcomes) lines.push(`  - ${o.id}: ${o.verdict} — ${o.evidence}`);
    for (const g of r.infraGaps) lines.push(`  - infra: ${g}`);
  }
  const conclusion = anyFail ? "REJECT" : anyHuman ? "NEEDS_HUMAN" : "APPROVE";
  lines.splice(1, 0, `conclusion: ${conclusion}  terminal: CONVERGED  run: ${runId}`);
  lines.push(`honesty: PERFORMANCE-ONLY-IN-LOOP (single-uid box until C-09/C-14 rulings)`);
  lines.push(`verify every recorded byte: ${spotcheckCommand(runDir)}`);
  return lines.join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const { cmd, flags, rest } = parseCliArgs(argv);
  if (cmd === "status") {
    const ledger = await loadLedger(DEFAULT_CHAMBER_LEDGER);
    const tail = typeof flags["tail"] === "string" ? Number(flags["tail"]) : 5;
    let rows: ChamberRecord[] = ledger.rows;
    if (typeof flags["run-id"] === "string") rows = rows.filter((r) => r.runId === flags["run-id"]);
    for (const r of rows.slice(-tail)) {
      console.log(`${r.runId} serial=${String(r.serial)} ${r.profile} ${r.terminal ?? "running"} rounds=${String(r.rounds)} artifacts=${String(r.artifacts.length)} evRows=${String(r.evidenceRows)} judge=${r.judgeModelId} dir=${r.runDir}`);
      if (typeof r.notes === "string" && r.notes.length > 0) console.log(`  notes: ${r.notes}`);
    }
    for (const d of ledger.dropped.slice(-tail)) console.error(`  ledger line ${String(d.line)} DROPPED: ${d.reason}`);
    if (rows.length === 0) console.log(`no chamber runs recorded (ledger: ${DEFAULT_CHAMBER_LEDGER})`);
    return 0;
  }
  if (cmd === "spotcheck") {
    const arg = rest[0];
    if (arg === undefined) return usage();
    const runDir = arg.startsWith("/") ? arg : join("/tmp", `sibyl-run-${arg}`);
    console.log(spotcheckCommand(runDir));
    return 0;
  }
  if (cmd === "kill") {
    const [runDir, role] = rest;
    if (runDir === undefined || role === undefined) return usage();
    const res = await killRole({ runDir, opencodeBin: "", configSource: "" }, role);
    console.log(res.ok ? `killed pgid for role ${role}` : `kill refused: ${res.reason ?? "?"}`);
    return res.ok ? 0 : 1;
  }
  if (cmd === "run") {
    const resolved = await resolveRun(flags);
    if (!resolved.ok) {
      console.error(`sibyl-chamber: ${resolved.error}`);
      return 2;
    }
    const run = resolved.run;
    if (flags["detach"] === true) {
      const child = spawn(process.execPath, [...process.argv.slice(1)].filter((a) => a !== "--detach"), {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`SIBYL chamber detached: run ${run.runId}\n  dir: ${run.runDir}\n  status: node src/cli.ts status --run-id ${run.runId}\n  voice will land in the run record; ledger stays append-only`);
      return 0;
    }
    if (run.chamber !== null) {
      const chamberCfg: ChamberConfig = { ...run.chamber };
      if (run.killInjection !== null) chamberCfg.killInjection = run.killInjection;
      const res = await runChamber(chamberCfg);
      for (const role of ["evidence", "pro", "con", "judge"] as const) {
        await collectSessionDb({ runDir: run.runDir, opencodeBin: run.laneCfg.opencodeBin, configSource: run.laneCfg.configSource }, role).catch(() => null);
      }
      console.log(renderVoice(buildVoice(res)));
      return 0;
    }
    if (run.exam !== null) {
      const driver = makeExamDriver(run.laneCfg, run.runDir, run.exam.modelId, run.timeoutMs);
      const results: ExamResult[] = [];
      const scPaths = typeof flags["scenario"] === "string" ? [flags["scenario"]] : [];
      if (flags["allow-unbellied"] !== true) {
        for (const sp of scPaths) {
          const b = await runBell(sp);
          if (!b.ok) { console.log(`SIBYL REFUSE — bell preflight failed for ${sp}: ${b.detail}`); return 1; }
          console.log(`bell preflight OK: ${sp} — ${b.detail}`);
        }
      }
      for (const sc of run.exam.scenarios) results.push(await runExamScenario(sc, run.runDir, driver));
      console.log(examVoice(results, run.runId, run.runDir));
      return 0;
    }
    return 2;
  }
  return usage();
}

function usage(): number {
  console.log(
    "usage: sibyl-chamber run --target <path|-> --goal <text> [--profile review|exam] [--scenario f.json ...]\n" +
      "                     [--model p/m] [--judge-pool id,id] [--seed s] [--max-rounds n] [--config json] [--detach]\n" +
      "                     [--kill-role <r> --kill-after <ms>] [--opencode-bin <path> --config-source <jsonc>]\n" +
      "       sibyl-chamber status [--run-id <id>] [--tail n]\n" +
      "       sibyl-chamber spotcheck <runDir|runId>\n" +
      "       sibyl-chamber kill <runDir> <role>",
  );
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
