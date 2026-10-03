// bell preflight: the ruler must be verified BEFORE any candidate runs (s06 law, mechanized).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBell, bellPathFor } from "../src/exam/bell.ts";

test("real scenario + sidecar: bell rings true", async () => {
  const r = await runBell("scenarios/portable-device-binding.json");
  assert.ok(r.ok, r.detail);
});

test("sabotage: always-green signal => bell refuses => venue refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bell-sabot-"));
  const sc = JSON.parse(await readFile("scenarios/portable-device-binding.json", "utf8")) as { signals: { contains?: string }[] };
  const disk = sc.signals.find((s) => s.contains !== undefined);
  assert.ok(disk);
  disk.contains = "IMPOSSIBLE-BYTES-XYZ";
  const sp = join(dir, "sabotaged.json");
  await writeFile(sp, JSON.stringify(sc));
  await writeFile(bellPathFor(sp), await readFile("scenarios/portable-device-binding.bell.json", "utf8"));
  const r = await runBell(sp);
  assert.equal(r.ok, false);
  assert.match(r.detail, /honest: FAIL/);
});

test("missing sidecar refuses by default (no silent fielding of untested rulers)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bell-none-"));
  const sp = join(dir, "nobody.json");
  await writeFile(sp, await readFile("scenarios/portable-device-binding.json", "utf8"));
  const r = await runBell(sp);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no bell sidecar/);
});

test("consistency signal: claim+contradiction FAILs, claim-only PASSes", async () => {
  const { gradeScenario } = await import("../src/exam/signals.ts");
  const fx = await mkdtemp(join(tmpdir(), "cons-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(fx, "plugin"), { recursive: true });
  const sig = { id: "c1", kind: "consistency" as const, claimPath: "{F}/R.md".replace("{F}", fx), claim: "already wired", contradictionPath: join(fx, "plugin/config.ts"), contradiction: "qwen", note: "n" };
  const scenario = { id: "t", canary: false, signals: [sig] };
  await writeFile(join(fx, "R.md"), "already wired, done!");
  await writeFile(join(fx, "plugin/config.ts"), "DEFAULT='qwen3.7-plus'");
  let g = await gradeScenario(scenario as never, [""], fx);
  assert.equal(g.outcomes[0]?.verdict, "FAIL");
  await writeFile(join(fx, "plugin/config.ts"), "model: env['X'] ?? ''");
  g = await gradeScenario(scenario as never, [""], fx);
  assert.equal(g.outcomes[0]?.verdict, "PASS");
});
