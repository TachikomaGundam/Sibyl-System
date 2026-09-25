// provenance: original clean-room Sibyl-System implementation (v1.1 general
// review entry) — ORD-2: Sibyl assists ANY review that is asked for, not one
// loop. One tool, one door: sibyl_review resolves nothing about the verdict —
// it launches the isolated chamber runner detached (zero sessions in the
// human's main list, L1) and hands back the run id + where to look. THE voice
// is the single renderVoice block the runner prints at terminal time into the
// run record; this launch receipt explicitly is NOT a conclusion.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tool } from "@opencode-ai/plugin";

import { internalError, readArtifact } from "./shared.ts";
import type { ToolContextLike, ToolDeps } from "./shared.ts";
import { compactIso } from "../state/record.ts";

export const REVIEW_TOOL_NAME = "sibyl_review";

/** Node for spawning the runner: the opencode host's process.execPath is the
 * native CLI binary, NOT a JS runtime — prefer a real node, probe honestly. */
export function nodeBinary(): string {
  return existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath;
}

/** Locate the CLI entry from either runtime position (src/tools dev, dist bundle). */
export function cliCommand(thisUrl: string, node: string): { bin: string; args: string[] } {
  const moduleDir = dirname(fileURLToPath(thisUrl)); // .../src/tools or .../dist
  const repoRoot = dirname(dirname(moduleDir));
  const distCli = join(repoRoot, "dist", "cli.js");
  if (existsSync(distCli)) return { bin: node, args: [distCli] };
  const srcCli = join(repoRoot, "src", "cli.ts");
  const hooks = join(repoRoot, "tools", "register-ts.mjs");
  return { bin: node, args: ["--import", hooks, srcCli] };
}

export type ReviewArgs = {
  target: string;
  goal: string;
  seed?: string | undefined;
  maxRounds?: number | undefined;
};

export type LaunchReceipt = { runId: string; runDir: string; statusCmd: string; spotcheck: string };

/** Build + detached-spawn the chamber run; NO verdict here — only the door. */
export async function reviewExecute(
  deps: ToolDeps,
  args: ReviewArgs,
  context: ToolContextLike,
): Promise<string> {
  try {
    if (args.goal.trim().length === 0) return "SIBYL review: goal is required (what question should the chamber answer?)";
    const opts = deps.options;
    const now = new Date();
    const runId = `sibyl-${compactIso(now)}-${randomBytes(2).toString("hex")}`;
    const runDir = join(opts.lane.runRoot, `sibyl-run-${runId}`);
    await mkdir(runDir, { recursive: true });

    const artifact = await readArtifact(args.target, context.directory);
    if (!artifact.ok) return `SIBYL review: ${artifact.error}`;
    let targetArg: string;
    if (artifact.kind === "inline") {
      targetArg = join(runDir, "target-inline.md");
      await writeFile(targetArg, artifact.text, "utf8");
    } else {
      targetArg = artifact.source;
    }

    await writeFile(join(runDir, "run-config.json"), `${JSON.stringify(opts, null, 2)}\n`, "utf8");

    const cmd = cliCommand(import.meta.url, nodeBinary());
    const spawnArgs = [
      ...cmd.args,
      "run",
      "--target",
      targetArg,
      "--goal",
      args.goal,
      "--config",
      join(runDir, "run-config.json"),
      "--run-root",
      opts.lane.runRoot,
      "--seed",
      args.seed !== undefined && args.seed.length > 0 ? args.seed : randomBytes(8).toString("hex"),
      ...(args.maxRounds !== undefined ? ["--max-rounds", String(args.maxRounds)] : []),
    ];
    const child = spawn(cmd.bin, spawnArgs, { cwd: runDir, detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`[sibyl review] runner spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();

    const receipt: LaunchReceipt = {
      runId,
      runDir,
      statusCmd: `${cmd.bin} ${cmd.args.join(" ")} status --run-id ${runId}`,
      spotcheck: `cd ${runDir} && sha256sum -c CHECKSUMS.txt`,
    };
    return [
      `SIBYL chamber launched — this receipt is NOT a verdict (the single voice lands at terminal state).`,
      `  run:      ${receipt.runId}`,
      `  dir:      ${receipt.runDir}`,
      `  status:   ${receipt.statusCmd}`,
      `  voice at: ${join(runDir, "run-record.json")} + chamber-ledger.jsonl (append-only)`,
      `  verify:   ${receipt.spotcheck}`,
    ].join("\n");
  } catch (err) {
    return internalError(REVIEW_TOOL_NAME, err);
  }
}

export function buildReviewTool(deps: ToolDeps) {
  return tool({
    description:
      "SIBYL general review (democratic-centralism chamber): broad evidence gathering, blind pro/con clash with cross-critique, " +
      "an independently-drawn judge, bounded rounds — then ONE conclusion in ONE voice. Serves any review need (documents, plans, " +
      "code, agent behavior packs). Launches an isolated headless chamber (zero sessions in your main list) and returns a receipt; " +
      "read the verdict voice from the run record / status when terminal.",
    args: {
      target: tool.schema.string().min(1).describe("File path (or multi-line inline content) of the artifact to review."),
      goal: tool.schema.string().min(1).describe("The question the chamber must answer, in one sentence."),
      seed: tool.schema.string().min(1).optional().describe("Judge-draw seed (E2); omit for a fresh random one."),
      maxRounds: tool.schema.number().int().min(1).max(8).optional().describe("Clash round cap (default from plugin options)."),
    },
    execute: async (args, context) =>
      await reviewExecute(deps, args as ReviewArgs, context as unknown as ToolContextLike),
  });
}
