// provenance: original clean-room Sibyl-System implementation (v1.1 exam
// runtime). E3: behavioral exam ITEMS are DATA (scenario JSON), never code —
// adding an item must not require touching the harness. Grading is mechanical:
// transcript events + disk re-probes decide, the candidate's own prose never
// counts as evidence (SR4 §0.5).

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SIGNAL_KINDS = ["order", "absent", "disk", "text", "consistency"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type SignalSpec = {
  id: string;
  kind: SignalKind;
  /** regex matching normalized event lines (tool name + argv + text). */
  pattern: string;
  /** for kind=order: the event that must NOT appear after `pattern` re-fires. */
  forbidAfter?: string;
  /** for kind=disk: path (may contain {fixtures}) + substring it must hold. */
  path?: string;
  contains?: string;
  /** kind=consistency: claim present at claimPath WHILE contradiction present at contradictionPath = FAIL. */
  claimPath?: string;
  claim?: string;
  contradictionPath?: string;
  contradiction?: string;
  /** a machine-generated row the grader appends on FAIL. */
  note: string;
};

export type ScenarioSpec = {
  schema: 1;
  id: string;
  class: string;
  canary: boolean;
  prompt: string;
  turns: string[];
  fixtures: Record<string, string>;
  signals: SignalSpec[];
};

export type ScenarioValidation = { ok: true } | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateSignal(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "signal not an object";
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !ID_RE.test(o["id"])) return `signal id invalid: ${String(o["id"])}`;
  if (!(SIGNAL_KINDS as readonly string[]).includes(String(o["kind"]))) return `signal ${o["id"]}: kind must be one of ${SIGNAL_KINDS.join("|")}`;
  if (typeof o["pattern"] !== "string" && o["kind"] !== "consistency") return `signal ${o["id"]}: pattern must be a string`;
  if (typeof o["pattern"] === "string" && o["pattern"].length > 0) {
    try {
      new RegExp(o["pattern"]);
    } catch (e) {
      return `signal ${o["id"]}: invalid regex: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (o["forbidAfter"] !== undefined && typeof o["forbidAfter"] !== "string") return `signal ${o["id"]}: forbidAfter must be string`;
  if (o["kind"] === "consistency") {
    for (const f of ["claimPath", "claim", "contradictionPath", "contradiction"] as const) {
      if (typeof o[f] !== "string" || (o[f] as string).length === 0) return `signal ${o["id"]}: consistency kind needs ${f}`;
    }
  }
  if (o["kind"] === "disk") {
    if (typeof o["path"] !== "string" || o["path"].length === 0) return `signal ${o["id"]}: disk kind needs path`;
    if (typeof o["contains"] !== "string") return `signal ${o["id"]}: disk kind needs contains`;
  }
  if (typeof o["note"] !== "string") return `signal ${o["id"]}: note (FAIL wording) required`;
  return null;
}

export function validateScenario(raw: unknown): ScenarioValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["scenario is not an object"] };
  const o = raw as Record<string, unknown>;
  if (o["schema"] !== 1) errors.push("schema must be 1");
  if (typeof o["id"] !== "string" || !ID_RE.test(o["id"])) errors.push("id must be kebab-case");
  if (typeof o["class"] !== "string" || o["class"].length === 0) errors.push("class required");
  if (typeof o["canary"] !== "boolean") errors.push("canary must be boolean");
  if (typeof o["prompt"] !== "string" || o["prompt"].trim().length === 0) errors.push("prompt required");
  if (!isStringArray(o["turns"])) errors.push("turns must be a string array");
  const fx = o["fixtures"];
  if (typeof fx !== "object" || fx === null || Array.isArray(fx)) errors.push("fixtures must be an object relpath->content");
  else {
    for (const rel of Object.keys(fx as Record<string, unknown>)) {
      if (rel.startsWith("/") || rel.includes("..")) errors.push(`fixture path must be relative & containment-safe: ${rel}`);
      if (typeof (fx as Record<string, unknown>)[rel] !== "string") errors.push(`fixture ${rel}: content must be a string`);
    }
  }
  if (!Array.isArray(o["signals"]) || o["signals"].length === 0) errors.push("signals: non-empty array required");
  else {
    for (const s of o["signals"]) {
      const e = validateSignal(s);
      if (e !== null) errors.push(e);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function parseScenario(text: string): ScenarioValidation & { scenario?: ScenarioSpec } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`scenario JSON invalid: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const v = validateScenario(raw);
  if (!v.ok) return v;
  return { ok: true, scenario: raw as ScenarioSpec };
}

/** Materialize fixtures into a fresh dir; returns the dir + expanded paths. */
export async function materializeFixtures(scenario: ScenarioSpec, label?: string): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), `sibyl-exam-${label ?? scenario.id}-`));
  const files: string[] = [];
  for (const [rel, content] of Object.entries(scenario.fixtures)) {
    const abs = join(dir, rel);
    await writeFile(abs, content, "utf8");
    files.push(abs);
  }
  return { dir, files };
}

/** Expand {fixtures} placeholders in prompt/turns/signal paths. */
export function expandFixtures(text: string, fixtureDir: string): string {
  return text.replaceAll("{fixtures}", fixtureDir);
}

export async function diskProbe(path: string): Promise<{ exists: boolean; text: string }> {
  try {
    const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
    return info.isFile() ? { exists: true, text } : { exists: false, text: "" };
  } catch {
    return { exists: false, text: "" };
  }
}
