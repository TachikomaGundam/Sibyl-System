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
import { existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirPrivate } from "./fsperm.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { compactIso, isIndependenceShape, type IndependenceRef } from "./state/record.ts";
import { instrumentFace } from "./instrument.ts";
import { DEFAULT_CHAMBER_LEDGER, listChecksumTargets, loadLedger, spotcheckCommand, writeChecksums, type ChamberRecord } from "./state/chamber.ts";
import { buildVoice, renderVoice } from "./chamber/synthesis.ts";
import { runChamber, type ChamberConfig, type ChamberRole, type Lane, type LaunchFacts } from "./chamber/protocol.ts";
import { launchRole, collectSessionDb, killRole, type LaneConfig } from "./lane/isolated.ts";
import { startCredentialProxy, type CredentialProxy, type RoleProxyConfig } from "./lane/proxy.ts";
import { parseScenario, type ScenarioSpec } from "./exam/scenario.ts";
import { runExamScenario, type CandidateDriver, type ExamResult } from "./exam/runner.ts";
import { runBell } from "./exam/bell.ts";
import { DEFAULT_ROLE_SALVAGE_GRACE_MS, DEFAULT_ROLE_TIMEOUT_MS, parseOptions, type CredentialProxyConfig, type PluginOptions } from "./options.ts";

export type CliFlags = Record<string, string | boolean | readonly string[]>;

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
        addStringFlag(flags, tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const name = tok.slice(2);
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith("--") && !BOOLEAN_FLAGS.includes(name)) {
          addStringFlag(flags, tok.slice(2), nxt);
          i += 1;
        } else flags[tok.slice(2)] = true;
      }
    } else rest.push(tok);
  }
  return { cmd, flags, rest };
}

function addStringFlag(flags: CliFlags, key: string, value: string): void {
  if (key !== "scenario") {
    flags[key] = value;
    return;
  }
  const prior = flags[key];
  if (typeof prior === "string") flags[key] = [prior, value];
  else if (Array.isArray(prior)) flags[key] = [...prior, value];
  else flags[key] = value;
}

function stringFlagValues(flags: CliFlags, key: string): readonly string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
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
  salvageGraceMs: number;
  chamber: ChamberConfig | null;
  exam: { scenarios: ScenarioSpec[]; modelId: string } | null;
  killInjection: { role: ChamberRole; afterMs: number } | null;
  examMaskDirs: string[];
  /** null = relay OFF (configSource copy, today's semantics). */
  credentialProxy: CredentialProxyConfig | null;
};

/** Fail-closed seat/proxy reconciliation: every provider a run intends to seat
 * must have an upstream in the proxy map, or the run refuses at resolution
 * time with an actionable, provider-named error (never a mid-run auth mystery). */
function proxyProviderError(proxyCfg: CredentialProxyConfig, providerID: string, where: string): string | null {
  const known = Object.keys(proxyCfg.providers).join(", ") || "(none configured)";
  if (providerID.length === 0) {
    return `credentialProxy is enabled but ${where} resolves to an empty providerID (host default), which the relay cannot own — point ${where} at a provider listed in credentialProxy.providers (${known}).`;
  }
  if (proxyCfg.providers[providerID] !== undefined) return null;
  return `credentialProxy is enabled but ${where} uses provider "${providerID}", which has no entry in credentialProxy.providers (known: ${known}) — add its upstream or seat ${where} on a proxied provider.`;
}

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
  const proxyCfg = opts?.credentialProxy ?? null;
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
  // W1 identity fix: a launcher that already minted the run id (sibyl_review)
  // passes it via --run-id so the LAUNCH receipt and the RUN RECORD name the
  // same run — and the launch-context the tool staged inside the run dir is
  // found by this process. Bare-name ids only (never a path).
  const flagRunId = typeof flags["run-id"] === "string" ? flags["run-id"] : null;
  if (flagRunId !== null && !/^sibyl-[A-Za-z0-9-]+$/.test(flagRunId)) {
    return { ok: false, error: `--run-id must be a bare sibyl run id, got "${flagRunId}"` };
  }
  const runId = flagRunId ?? `sibyl-${compactIso(now)}-${randomBytes(2).toString("hex")}`;
  // pre-flight target probe (order matters for receipts: an unreadable target is the
  // caller's problem and must surface BEFORE any run-dir side effect — creation,
  // refusal records — so failed launches leave no /tmp litter behind).
  if (targetRaw !== "-") {
    const abs = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);
    try {
      await access(abs);
    } catch (e) {
      return { ok: false, error: `--target unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const runDir = join(laneCfg.runRoot, `sibyl-run-${runId}`);
  await mkdirPrivate(runDir);
  const failAfterRun = async (error: string): Promise<{ ok: false; error: string }> => {
    await rm(runDir, { recursive: true, force: true });
    return { ok: false, error };
  };

  // F-W1b option 3 (council run sibyl-20261023T102611Z-16a2, owner-approved 2026-10-23):
  // an explicit --run-id declares a TOOL-launched review; if the tool never staged its
  // launch-context (or staged garbage), refusing is honest. Headless callers keep the
  // bare path (no --run-id), where the leg is NAMED UNVERIFIABLE by design — the flip
  // would otherwise manufacture a W2-banned absence-without-record at the service face.
  // A refusal still records itself: launch-refusal.json inside the private run dir.
  let contextLeg: Record<string, unknown> | null = null;
  let contextProblem: string | null = null;
  try {
    const lc = JSON.parse(await readFile(join(runDir, "launch-context.json"), "utf8")) as Record<string, unknown>;
    if (isIndependenceShape(lc["independence"])) contextLeg = lc;
    else contextProblem = "launch-context staged but its independence leg is malformed";
  } catch (err) {
    contextProblem =
      err instanceof Error && err.name === "SyntaxError"
        ? "launch-context exists but is not valid JSON"
        : "no launch-context staged in the run dir";
  }
  if (flagRunId !== null && contextProblem !== null) {
    const refusal = {
      kind: "refused-launch",
      runId: flagRunId,
      reason:
        `${contextProblem} — a --run-id launch claims a tool-staged review that never happened; ` +
        "rerun through the sibyl_review tool, or drop --run-id for the supported bare headless launch",
      at: now.toISOString(),
    };
    await writeFile(join(runDir, "launch-refusal.json"), `${JSON.stringify(refusal, null, 2)}\n`, "utf8");
    return { ok: false, error: refusal.reason };
  }

  let launchIndependence: IndependenceRef;
  if (contextLeg !== null) {
    launchIndependence = contextLeg["independence"] as IndependenceRef;
    // self-report guard (same run 16a2): the run record the chamber runner regenerates is
    // the tool's OWN face; a staged context cannot outvouch it once the face exists.
    try {
      const face = JSON.parse(await readFile(join(runDir, "run-record.json"), "utf8")) as Record<string, unknown>;
      const faceInd = face["independence"];
      if (isIndependenceShape(faceInd) && faceInd.status !== launchIndependence.status) {
        launchIndependence = {
          ...faceInd,
          evidence: `context claimed ${launchIndependence.status}, run record carries ${faceInd.status} — record wins. ${faceInd.evidence}`,
        };
      }
    } catch {
      /* face not written yet: the staged context is the only face, kept as staged */
    }
  } else {
    // bare CLI launch: no wrapper resolved a convener. Absence of the field was
    // the old silent hole; the field must be present and NAMED (W1 header rule:
    // missing-field-is-violation, digest §three.2).
    launchIndependence = {
      status: "UNVERIFIABLE",
      convenerChain: [],
      evidence: "bare CLI launch: no convener session staged; the drafting-chain read was impossible by construction",
    };
  }

  let targetPath = targetRaw;
  if (targetRaw !== "-") {
    const abs = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);
    targetPath = join(runDir, "target", basename(abs));
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await copyFile(abs, targetPath);
    } catch (e) {
      return failAfterRun(`--target unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const profile = typeof flags["profile"] === "string" ? flags["profile"] : "review";
  let killInjection: ResolvedRun["killInjection"] = null;
  if (typeof flags["kill-role"] === "string" && typeof flags["kill-after"] === "string") {
    if (!["evidence", "pro", "con", "judge"].includes(flags["kill-role"])) return failAfterRun("--kill-role invalid");
    const afterMs = Number(flags["kill-after"]);
    if (!Number.isFinite(afterMs) || afterMs < 0) return failAfterRun("--kill-after must be ms");
    killInjection = { role: flags["kill-role"] as ChamberRole, afterMs };
  }

  const timeoutMs = opts?.lane.roleTimeoutMs ?? DEFAULT_ROLE_TIMEOUT_MS;
  const salvageGraceMs = opts?.lane.roleSalvageGraceMs ?? DEFAULT_ROLE_SALVAGE_GRACE_MS;
  if (profile === "exam") {
    const list = stringFlagValues(flags, "scenario");
    const scenarios: ScenarioSpec[] = [];
    for (const p of list) {
      let raw: string;
      try {
        raw = await readFile(p, "utf8");
      } catch (e) {
        return failAfterRun(`scenario ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const v = parseScenario(raw);
      if (!v.ok) return failAfterRun(`scenario ${p}: ${v.errors.join("; ")}`);
      scenarios.push(v.scenario as ScenarioSpec);
    }
    if (scenarios.length === 0) return failAfterRun("--profile exam needs at least one --scenario");
    const only = splitModelId(modelFlag ?? "") ?? null;
    if (only === null) return failAfterRun("--profile exam requires --model provider/model");
    if (proxyCfg !== null) {
      const bad = proxyProviderError(proxyCfg, only.providerID, "--model");
      if (bad !== null) return failAfterRun(bad);
    }
    return { ok: true, run: { runId, runDir, laneCfg, timeoutMs, salvageGraceMs, chamber: null, exam: { scenarios, modelId: modelFlag as string }, killInjection, examMaskDirs: opts?.lane.examMaskDirs ?? [], credentialProxy: proxyCfg } };
  }
  if (profile !== "review") return failAfterRun(`unknown --profile ${profile}`);

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
  if (proxyCfg !== null) {
    const fallback = { providerID: "", modelID: "" };
    const seatedSlots = new Set<string>(modelFlag !== null ? ["default"] : [...Object.values(slots), ...judgeSlotNames]);
    for (const slot of seatedSlots) {
      const pid = (effectivePool[slot] ?? effectivePool["default"] ?? fallback).providerID;
      const bad = proxyProviderError(proxyCfg, pid, `model pool slot "${slot}"`);
      if (bad !== null) return failAfterRun(bad);
    }
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
    independence: launchIndependence,
    slots,
    judgePoolIds: judgePoolIds.length > 0 ? judgePoolIds : [...new Set(judgeSlotNames.map((s) => slotToId(s, effectivePool)).filter((x): x is string => x !== null))],
    lane: null as unknown as Lane, // wired below (type seam: lane needs cfg, cfg needs lane)
  };
  chamber.lane = makeIsolatedLane(chamber, laneCfg, timeoutMs, salvageGraceMs, null);
  return { ok: true, run: { runId, runDir, laneCfg, timeoutMs, salvageGraceMs, chamber, exam: null, killInjection, examMaskDirs: opts?.lane.examMaskDirs ?? [], credentialProxy: proxyCfg } };
}

function slotToId(slot: string, pool: Record<string, { providerID: string; modelID: string }>): string | null {
  const m = pool[slot] ?? pool["default"];
  if (m === undefined || m.providerID.length === 0 || m.modelID.length === 0) return null;
  return `${m.providerID}/${m.modelID}`;
}

function makeIsolatedLane(cfg: ChamberConfig, laneCfg: LaneBase, timeoutMs: number, salvageGraceMs: number, roleProxy: CredentialProxy | null): Lane {
  return {
    async launch(req: { role: string; title: string; modelId: string; message: string; launchId: string }): Promise<LaunchFacts> {
      const model = splitModelId(req.modelId);
      if (model === null) return { ok: false, rc: null, signal: null, timedOut: false };
      let proxyRole: RoleProxyConfig | undefined;
      if (roleProxy !== null) {
        const issued = roleProxy.issueRole(req.role, model.providerID);
        if (!issued.ok) return { ok: false, rc: null, signal: null, timedOut: false };
        proxyRole = issued.config;
      }
      const outcome = await launchRole(
        {
          runDir: cfg.runDir,
          opencodeBin: laneCfg.opencodeBin,
          configSource: laneCfg.configSource,
          sandboxMaskDirs: ["/home"],
          requireSandbox: process.platform === "linux",
          sandboxWriteScope: "role",
          ...(proxyRole !== undefined ? { proxyRole } : {}),
        },
        req.role,
        { title: req.title, modelId: req.modelId, message: req.message, launchId: req.launchId, timeoutMs, salvageGraceMs, pure: true },
      );
      return { ok: outcome.ok, rc: outcome.rc, signal: outcome.signal, timedOut: outcome.timedOut, ...(outcome.salvagedMs !== undefined ? { salvagedMs: outcome.salvagedMs } : {}) };
    },
    async kill(role: string): Promise<{ ok: boolean; reason?: string }> {
      return await killRole({ runDir: cfg.runDir, opencodeBin: laneCfg.opencodeBin, configSource: laneCfg.configSource }, role);
    },
  };
}

function makeExamDriver(laneCfgBase: LaneBase, runDir: string, modelId: string, timeoutMs: number, maskDirs: readonly string[], bwrapProbe: string, candidateProxy: RoleProxyConfig | null): { driver: CandidateDriver; sandboxed: boolean } {
  const lc: LaneConfig = {
    runDir,
    opencodeBin: laneCfgBase.opencodeBin,
    configSource: laneCfgBase.configSource,
    sandboxMaskDirs: maskDirs,
    bwrapBin: bwrapProbe,
    ...(candidateProxy !== null ? { proxyRole: candidateProxy } : {}),
  };
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
    sandboxed: maskDirs.length > 0 && existsSync(bwrapProbe),
    driver: {
      start: async (prompt) => await run(prompt),
      continueTurn: async (sid, message) => await run(message, sid),
    },
  };
}

export function examVoice(results: ExamResult[], runId: string, runDir: string, venueSandbox: string): string {
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
  lines.push(`venue sandbox: ${venueSandbox}`);
  lines.push(`verify every recorded byte: ${spotcheckCommand(runDir)}`);
  return lines.join("\n");
}

// W6 dead-without-record probe: a runner that died at/before resolveRun leaves
// only the launcher's staged files. Any of these traces means it got somewhere
// (or was legitimately refused) — absence of ALL of them + ledger silence =
// the dead-run state this probe names instead of the old "no chamber runs
// recorded" shrug.
const LIVE_TRACE_NAMES: readonly string[] = ["target", "pids", "evidence", "pro", "con", "judge", "run-record.json", "chamber-ledger.jsonl", "launch-refusal.json"];

export async function deadWithoutRecord(runDir: string): Promise<{ dead: boolean; dirExists: boolean; entries: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return { dead: false, dirExists: false, entries: [] };
  }
  const traced = entries.filter((e) => LIVE_TRACE_NAMES.includes(e));
  return { dead: traced.length === 0, dirExists: true, entries: entries.sort() };
}

export async function main(argv: readonly string[]): Promise<number> {
  const { cmd, flags, rest } = parseCliArgs(argv);
  if (cmd === "status") {
    const ledger = await loadLedger(DEFAULT_CHAMBER_LEDGER);
    const tail = typeof flags["tail"] === "string" ? Number(flags["tail"]) : 5;
    let rows: ChamberRecord[] = ledger.rows;
    if (typeof flags["run-id"] === "string") {
      rows = rows.filter((r) => r.runId === flags["run-id"]);
      if (rows.length === 0) {
        const root = typeof flags["run-root"] === "string" ? (flags["run-root"] as string) : "/tmp";
        const dir = join(root, `sibyl-run-${flags["run-id"]}`);
        const state = await deadWithoutRecord(dir);
        if (state.dead) {
          console.log(`run ${flags["run-id"]}: DEAD-WITHOUT-RECORD — dir ${dir} holds only [${state.entries.join(", ")}]; the runner died before any record. Runner stderr (if the launcher captured it): ${join(dir, "startup.log")}`);
          return 0;
        }
        if (state.dirExists) {
          console.log(`run ${flags["run-id"]}: no ledger row yet, but the run dir shows live traces (${state.entries.join(", ")}) — still running or died mid-phase`);
          return 0;
        }
      }
    }
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
    // credential relay lifecycle: started ONLY when configured, closed in the
    // finally on every exit path (the real keys live nowhere else in this run).
    let proxy: CredentialProxy | null = null;
    try {
      if (run.credentialProxy !== null) {
        const started = await startCredentialProxy({
          upstreams: run.credentialProxy.providers,
          maxRequestsPerRole: run.credentialProxy.maxRequestsPerRole,
          receiptsPath: join(run.runDir, "proxy-receipts.jsonl"),
        });
        if (!started.ok) {
          console.error(`sibyl-chamber: credential proxy refused: ${started.error}`);
          return 2;
        }
        proxy = started.proxy;
      }
      return await executeRun(run, proxy, flags);
    } finally {
      if (proxy !== null) await proxy.close();
    }
  }
  return usage();
}

async function executeRun(run: ResolvedRun, proxy: CredentialProxy | null, flags: CliFlags): Promise<number> {
  if (run.chamber !== null) {
    const chamberCfg: ChamberConfig = { ...run.chamber };
    if (run.killInjection !== null) chamberCfg.killInjection = run.killInjection;
    if (proxy !== null) chamberCfg.lane = makeIsolatedLane(chamberCfg, run.laneCfg, run.timeoutMs, run.salvageGraceMs, proxy);
    const res = await runChamber(chamberCfg);
    for (const role of ["evidence", "pro", "con", "judge"] as const) {
      await collectSessionDb({ runDir: run.runDir, opencodeBin: run.laneCfg.opencodeBin, configSource: run.laneCfg.configSource }, role).catch(() => null);
    }
    console.log(renderVoice(buildVoice(res)));
    return 0;
  }
  if (run.exam !== null) {
    let candidateProxy: RoleProxyConfig | null = null;
    if (proxy !== null) {
      const issued = proxy.issueRole("candidate", splitModelId(run.exam.modelId)?.providerID ?? "");
      if (!issued.ok) {
        console.error(`sibyl-chamber: credential proxy refused the candidate seat: ${issued.error}`);
        return 2;
      }
      candidateProxy = issued.config;
    }
    const { driver, sandboxed } = makeExamDriver(run.laneCfg, run.runDir, run.exam.modelId, run.timeoutMs, run.examMaskDirs, "/usr/bin/bwrap", candidateProxy);
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
    // exam runs now seal their face too: the ONE-VOICE verify line must be true
    await writeChecksums(run.runDir, await listChecksumTargets(run.runDir));
    console.log(examVoice(results, run.runId, run.runDir, sandboxed ? `ON (masked ${String(run.examMaskDirs.length)} dir(s))` : run.examMaskDirs.length === 0 ? "OFF (lane.examMaskDirs empty — grader files are candidate-readable)" : "OFF (bwrap missing at /usr/bin/bwrap)"));
    return 0;
  }
  return 2;
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
  // W6 fatal boundary (wound sibyl-20261102T133505Z-4393): a launched runner's
  // streams can be detached/ignored, so an uncaught fault here used to vanish
  // entirely. Any rejection now lands in startup-error.json inside the run dir
  // when the run coordinates are known from argv — dead, but never without a
  // record. Absent coordinates, the fault goes to stderr and exit 1.
  const reportFatal = async (where: string, err: unknown): Promise<void> => {
    const argv = process.argv.slice(2);
    const flagVal = (name: string): string | null => {
      const i = argv.indexOf(`--${name}`);
      if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) return argv[i + 1] as string;
      const eq = argv.find((a) => a.startsWith(`--${name}=`));
      return eq === undefined ? null : eq.slice(name.length + 3);
    };
    const runId = flagVal("run-id");
    const root = flagVal("run-root") ?? "/tmp";
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    process.exitCode = 1;
    if (runId === null || !/^sibyl-[A-Za-z0-9-]+$/.test(runId)) {
      console.error(`sibyl-chamber ${where}: ${message}`);
      return;
    }
    const runDir = join(root, `sibyl-run-${runId}`);
    const payload = `${JSON.stringify({ kind: "startup-fatal", where, runId, at: new Date().toISOString(), error: message }, null, 2)}\n`;
    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "startup-error.json"), payload, "utf8");
    } catch {
      console.error(`sibyl-chamber ${where}: ${message}`);
    }
  };
  process.on("unhandledRejection", (reason) => {
    void reportFatal("unhandledRejection", reason);
  });
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    await reportFatal("main", err);
  }
}
