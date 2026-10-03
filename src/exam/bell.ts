// provenance: bell-test preflight (ruler health as MECHANISM, not discipline) —
// owner-approved 2026-10-03. A scenario ships a sidecar <id>.bell.json with
// synthetic phases: an honest script that MUST grade PASS and planted-dirt
// scripts that MUST grade FAIL (s06 lesson: an unverified ruler poisons every
// verdict; today four ruler injuries died in this bell before live fire).
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseScenario } from "./scenario.ts";
import { gradeScenario } from "./signals.ts";

export type BellPhase = {
  name: string;
  expect: "PASS" | "FAIL";
  /** transcript turns; rows may reference {F} = this phase's fixtures dir. */
  turns: string[][];
  fixtures: Record<string, string>;
};
export type BellSpec = { schema: 2; phases: BellPhase[] };

export function bellPathFor(scenarioPath: string): string {
  return scenarioPath.replace(/\.json$/, ".bell.json");
}

export type BellResult = { ok: boolean; detail: string };

export async function runBell(scenarioPath: string): Promise<BellResult> {
  const bellRaw = await readFile(bellPathFor(scenarioPath), "utf8").catch(() => null);
  if (bellRaw === null) return { ok: false, detail: "no bell sidecar (ruler untested — refusal by default)" };
  let bell: BellSpec;
  try {
    bell = JSON.parse(bellRaw) as BellSpec;
  } catch (e) {
    return { ok: false, detail: `bell sidecar unparseable: ${String(e).slice(0, 120)}` };
  }
  const spec = parseScenario(await readFile(scenarioPath, "utf8"));
  if (!spec.ok) return { ok: false, detail: `scenario invalid: ${JSON.stringify((spec as { errors: string[] }).errors).slice(0, 200)}` };
  const hasHonest = bell.phases.some((p) => p.name === "honest" && p.expect === "PASS");
  const hasDirty = bell.phases.some((p) => p.expect === "FAIL");
  if (!hasHonest || !hasDirty) return { ok: false, detail: "bell needs >=1 honest(PASS) and >=1 dirty(FAIL) phase" };
  const lines: string[] = [];
  for (const ph of bell.phases) {
    const dir = await mkdtemp(join(tmpdir(), `bell-${ph.name}-`));
    const fx = join(dir, "fixtures");
    for (const [rel, content] of Object.entries(ph.fixtures)) {
      const abs = join(fx, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    const turns = ph.turns.map((g) => g.map((l) => l.replaceAll("{F}", fx)).join("\n"));
    const g = await gradeScenario(spec.scenario as never, turns, fx);
    const hit = g.verdict === ph.expect;
    lines.push(`${ph.name}: ${g.verdict} (expect ${ph.expect}) ${hit ? "OK" : "MISMATCH"}`);
    if (!hit) return { ok: false, detail: lines.join("; ") };
  }
  return { ok: true, detail: lines.join("; ") };
}
