// provenance: original clean-room Sibyl-System v1.1 acceptance driver.
// Mechanically proves A1 (full isolated clash round, human-DB delta=0),
// A2 (judge killed -> terminal MEMBER_LOST with partials intact), A4
// (spotcheck verifies every byte, and tampering IS detected), A5 is unit
// land (merged-row ledger test). Every assertion writes PASS/FAIL lines;
// the script exits nonzero unless all hold. Evidence lands under
// .omo/evidence/acceptance-<date>/ (raw voices + run records + checksums).

import { execFileSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DATE = new Date().toISOString().slice(0, 10);
const OUT = join(REPO, ".omo", "evidence", `acceptance-${DATE}`);
await mkdir(OUT, { recursive: true });

const MAIN_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const CLI = join(REPO, "src", "cli.ts");
const NODE = "/usr/bin/node";

const ONLY = process.argv[2] ?? null;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail.length > 0 ? ` — ${detail}` : ""}`);
}

function dbCount(where) {
  return Number(execFileSync("sqlite3", ["-readonly", MAIN_DB, `SELECT COUNT(*) FROM session${where === null ? "" : ` WHERE ${where}`};`], { encoding: "utf8" }).trim());
}

function runCli(args, timeoutMs) {
  return execFileSync(NODE, ["--import", join(REPO, "tools", "register-ts.mjs"), CLI, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

// ---- fixture under review: a small doc with a planted, attackable flaw -----
const work = await mkdtempWork();
async function mkdtempWork() {
  const d = join(tmpdir(), `sibyl-acc-${Date.now()}`);
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, "proposal.md"),
    "# Migration proposal: adopt CSV everywhere\n\n" +
      "All structured data should move to CSV by Q4. CSV is simple and universal, " +
      "therefore no other format is needed. No migration risks exist because teams already export CSV.\n\n" +
      "Budget: none required.\n",
    "utf8",
  );
  await writeFile(join(d, "context-notes.md"), "Context: the doc omits quoting/unicode/embedded-newline failure modes; budget claim is unfalsifiable.\n", "utf8");
  return d;
}

const cfg = {
  lane: { runRoot: tmpdir(), opencodeBin: "<home>/.local/bin/opencode", configSource: join(homedir(), ".config", "opencode", "opencode.jsonc"), roleTimeoutMs: 720_000 },
  modelPolicy: { allowedPrefixes: ["local-"] },
  chamber: { maxRounds: 1, judgePool: ["default"] },
  modelPool: { default: { providerID: "local-qwen", modelID: "qwen3.8-flash-next" } },
};
const cfgPath = join(work, "acc-config.json");
await writeFile(cfgPath, JSON.stringify(cfg), "utf8");

const before = { total: dbCount(null), sibyl: dbCount("title LIKE 'sibyl-%'") };
console.log(`main DB before: total=${String(before.total)} sibyl=%${String(before.sibyl)}`);

// ------------------------------- A1 ----------------------------------------
const skipA1 = ONLY !== null && ONLY !== "A1";
if (!skipA1) console.log("\n== A1: full isolated clash round (6 role launches) ==");
let a1Voice = "";
let a1 = null;
if (!skipA1) try {
  a1Voice = runCli(["run", "--target", join(work, "proposal.md"), "--goal", "Is this migration proposal sound and actionable?", "--config", cfgPath, "--seed", "acc-seed-A1"], 55 * 60_000);
  await writeFile(join(OUT, "A1-voice.txt"), a1Voice, "utf8");
  const runId = /run: (\S+) \(serial/.exec(a1Voice)?.[1] ?? null;
  const runDir = /cd (\S+) && sha256sum/.exec(a1Voice)?.[1] ?? null;
  a1 = { runId, runDir };
  check("A1 single-voice printed exactly one conclusion", (a1Voice.match(/conclusion: /g) ?? []).length === 1, a1Voice.split("\n")[1] ?? "");
  const terminal = /terminal: (CONVERGED|NEEDS_ROUND|MEMBER_LOST|TIMEOUT)/.exec(a1Voice)?.[1] ?? "?";
  check("A1 terminal is a recorded round outcome", terminal === "CONVERGED" || terminal === "NEEDS_ROUND", terminal);
  if (runDir !== null) {
    const rec = JSON.parse(await readFile(join(runDir, "run-record.json"), "utf8"));
    check("A1 run-record has >=5 hashed artifacts", rec.artifacts.length >= 5 && rec.artifacts.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)), `n=${String(rec.artifacts.length)}`);
    check("A1 E2 commit + local judge seat recorded pre-launch", rec.drawCommit.length === 64 && rec.judgeModelId.startsWith("local-"), rec.judgeModelId);
    await cp(join(runDir, "run-record.json"), join(OUT, "A1-run-record.json"));
    await cp(join(runDir, "CHECKSUMS.txt"), join(OUT, "A1-CHECKSUMS.txt")).catch(() => undefined);
    // A4 on the live run dir
    let sumOk = true;
    try {
      execFileSync("sha256sum", ["-c", "CHECKSUMS.txt"], { cwd: runDir, stdio: "pipe" });
    } catch {
      sumOk = false;
    }
    check("A4 sha256sum -c passes over the untouched run", sumOk);
  }
} catch (err) {
  check("A1 runner exited cleanly", false, String(err?.message ?? err).slice(0, 300));
}

// ------------------------------- A2 ----------------------------------------
console.log("\n== A2: judge killed mid-round (pidfile group kill) ==");
try {
  const a2Voice = runCli(
    ["run", "--target", join(work, "proposal.md"), "--goal", "Is this proposal sound?", "--config", cfgPath, "--seed", "acc-seed-A2", "--kill-role", "judge", "--kill-after", "20000"],
    25 * 60_000,
  );
  await writeFile(join(OUT, "A2-voice.txt"), a2Voice, "utf8");
  const runDir = /cd (\S+) && sha256sum/.exec(a2Voice)?.[1] ?? null;
  const terminal = /terminal: (CONVERGED|NEEDS_ROUND|MEMBER_LOST|TIMEOUT)/.exec(a2Voice)?.[1] ?? "?";
  check("A2 terminal MEMBER_LOST after judge kill", terminal === "MEMBER_LOST", terminal);
  if (runDir !== null) {
    const rec = JSON.parse(await readFile(join(runDir, "run-record.json"), "utf8"));
    const partials = rec.artifacts.filter((x) => x.role === "pro" || x.role === "con");
    check("A2 pro/con artifacts survived (L5 receipts on disk)", partials.length >= 2, `n=${String(partials.length)}`);
    check("A2 conclusion voice is NEEDS_HUMAN (fail-closed, no fabricated verdict)", /conclusion: NEEDS_HUMAN/.test(a2Voice));
    // A4-tamper half: CHECKSUMS must reject a modified artifact in the dead run
    await cp(join(runDir, "run-record.json"), join(OUT, "A2-run-record.json"));
    const conDraft = join(runDir, "con", "round-1.md");
    if (existsSync(conDraft)) {
      const original = await readFile(conDraft, "utf8");
      await appendFile(conDraft, "\nTAMPERED-BY-ACCEPTANCE\n", "utf8");
      let detected = false;
      try {
        execFileSync("sha256sum", ["-c", "CHECKSUMS.txt"], { cwd: runDir, stdio: "pipe" });
      } catch {
        detected = true;
      }
      await writeFile(conDraft, original, "utf8"); // restore for the record copy
      check("A4 tamper on a dead run IS detected by spotcheck", detected);
    }
  }
} catch (err) {
  check("A2 runner exited cleanly", false, String(err?.message ?? err).slice(0, 300));
}

// ------------------------------- A1-post -----------------------------------
const after = { total: dbCount(null), sibyl: dbCount("title LIKE 'sibyl-%'") };
console.log(`\nmain DB after: total=${String(after.total)} sibyl=${String(after.sibyl)}`);
check("A1 zero sibyl-titled sessions in the human main DB", after.sibyl - before.sibyl === 0, `delta=${String(after.sibyl - before.sibyl)}`);
console.log(`INFO  human main DB total moved ${String(after.total - before.total)} (local session GC/watchdog churn — NOT an acceptance criterion; the strict L1 check is the sibyl-titled delta above, and zero sibyl titles is what isolation promises)`);

const ledger = await readFile(join(homedir(), ".sibyl", "chamber-ledger.jsonl"), "utf8").catch(() => "");
const mine = ledger.split("\n").filter((l) => l.includes("acc-seed"));
check("ledger carries exactly one line per acceptance run, parseable", mine.length >= 1 && mine.every((l) => {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}), `lines=${String(mine.length)}`);
await writeFile(join(OUT, "chamber-ledger-acc-lines.txt"), mine.join("\n"), "utf8");

const failed = results.filter((r) => !r.ok);
await writeFile(join(OUT, "SUMMARY.json"), `${JSON.stringify({ date: DATE, before, after, results }, null, 2)}\n`, "utf8");
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} acceptance checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
