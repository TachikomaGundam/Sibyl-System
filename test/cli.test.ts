// provenance: v1.1 CLI + review-door tests — argument grammar, seat-config
// resolution against policy, and the review tool's no-spawn error paths. The
// real end-to-end chamber is acceptance (e2e/acceptance.mjs), not unit land.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCliArgs, resolveRun, splitModelId, examVoice } from "../src/cli.ts";
import { cliCommand, nodeBinary, reviewExecute } from "../src/tools/review.ts";
import { parseOptions } from "../src/options.ts";
import { RunStore } from "../src/state/index.ts";
import { toEngineClient } from "../src/index.ts";

test("parseCliArgs: = form, space form, bare booleans, positional rest", () => {
  const r = parseCliArgs(["run", "--target", "/tmp/a.md", "--goal=did it hold?", "--detach", "extra"]);
  assert.equal(r.cmd, "run");
  assert.equal(r.flags["target"], "/tmp/a.md");
  assert.equal(r.flags["goal"], "did it hold?");
  assert.equal(r.flags["detach"], true);
  assert.deepEqual(r.rest, ["extra"]);
});

test("splitModelId: first-slash split, rejects degenerate ids", () => {
  assert.deepEqual(splitModelId("local-qwen/qwen3.8-flash-next"), { providerID: "local-qwen", modelID: "qwen3.8-flash-next" });
  assert.deepEqual(splitModelId("a/b/c"), { providerID: "a", modelID: "b/c" });
  assert.equal(splitModelId("noslash"), null);
  assert.equal(splitModelId("/leading"), null);
  assert.equal(splitModelId("trailing/"), null);
});

test("resolveRun: missing goal / bad model / no config seat -> structured errors, no run dir left usable", async () => {
  assert.ok(!(await resolveRun({ target: "/tmp/x" })).ok);
  const badModel = await resolveRun({ target: "/tmp/x", goal: "g", model: "malformed" });
  assert.ok(!badModel.ok);
  assert.match(badModel.ok ? "" : badModel.error, /provider\/model/);
});

test("resolveRun: copy of target into run dir + config-file seats + run-root honor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "artifact.md");
  await writeFile(target, "# doc\nclaim one\n", "utf8");
  const configPath = join(dir, "opts.json");
  const opts = parseOptions({
    lane: { runRoot: dir, opencodeBin: "/usr/bin/true", configSource: "", roleTimeoutMs: 30_000 },
    modelPolicy: { allowedPrefixes: ["local-"] },
    chamber: { maxRounds: 2, roles: { evidence: "s1", pro: "s1", con: "s1", judge: "s1" }, judgePool: ["s1"] },
    modelPool: { default: { providerID: "local-x", modelID: "m" }, s1: { providerID: "local-x", modelID: "m" } },
  });
  assert.ok(opts.ok);
  await writeFile(configPath, JSON.stringify(opts.ok ? opts.options : {}), "utf8");

  const r = await resolveRun({ target, goal: "is the doc sound", config: configPath, seed: "seed-7" });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.ok(existsSync(join(r.run.runDir, "target", "artifact.md")), "target copied into the sealed run dir");
  assert.equal(r.run.chamber?.seed, "seed-7");
  assert.equal(r.run.chamber?.maxRounds, 2);
  assert.deepEqual(r.run.chamber?.judgePoolIds, ["local-x/m"]);
  const cfgBack = await readFile(configPath, "utf8");
  assert.match(cfgBack, /allowedPrefixes/);
});

test("resolveRun: config with an empty pool and no --model -> judge pool empty => runChamber start-line deny (checked at draw)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-cli2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "a.md");
  await writeFile(target, "x", "utf8");
  const configPath = join(dir, "opts.json");
  const opts = parseOptions({});
  assert.ok(opts.ok);
  await writeFile(configPath, JSON.stringify(opts.ok ? opts.options : {}), "utf8");
  const r = await resolveRun({ target, goal: "g", config: configPath, "run-root": dir });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.run.chamber?.judgePoolIds, [], "placeholder pool yields no legal judge ids — fail-closed at draw");
});

test("examVoice: single conclusion line, canary veto visible, spotcheck appended", () => {
  const out = examVoice(
    [
      {
        scenarioId: "canary-x",
        canary: true,
        grade: { scenarioId: "canary-x", canary: true, outcomes: [{ id: "s", verdict: "FAIL", evidence: "no re-read" }], verdict: "FAIL" },
        veto: true,
        infraGaps: [],
        fixtureDir: "/f",
        transcriptDir: "/t",
      },
    ],
    "sibyl-1",
    "/tmp/sibyl-run-sibyl-1",
  );
  assert.equal(out.match(/conclusion: /g)?.length, 1);
  assert.match(out, /REJECT/);
  assert.match(out, /CANARY-VETO/);
  assert.match(out, /sha256sum -c CHECKSUMS.txt/);
});

test("nodeBinary + cliCommand resolve dev-layout entry", () => {
  const node = nodeBinary();
  assert.ok(node.length > 0);
  const cmd = cliCommand(import.meta.url, node);
  assert.equal(cmd.bin, node);
  assert.ok(cmd.args.some((a) => a.includes("cli.")), JSON.stringify(cmd.args));
});

test("reviewExecute error doors return strings, never throw, never spawn", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const opts = parseOptions({ lane: { runRoot: dir, opencodeBin: "/usr/bin/true", configSource: "", roleTimeoutMs: 30_000 } });
  assert.ok(opts.ok);
  if (!opts.ok) return;
  const deps = {
    client: toEngineClient({} as unknown as Parameters<typeof toEngineClient>[0]),
    store: new RunStore({ runsFile: join(dir, "runs.json"), spaceRoot: dir }),
    options: opts.options,
  };
  const ctx = { directory: dir, abort: new AbortController().signal, sessionID: "ses_cli" };
  const noGoal = await reviewExecute(deps, { target: "x.md", goal: "  " }, ctx);
  assert.match(noGoal, /goal is required/);
  const badTarget = await reviewExecute(deps, { target: join(dir, "missing-file.md"), goal: "g" }, ctx);
  assert.match(badTarget, /SIBYL review:/);
  assert.match(badTarget, /ENOENT|no such file/);
});
