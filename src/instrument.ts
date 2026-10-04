// provenance: W3 instrument-version-on-the-ballot (handoff HANDOFF-SIBYL-20261004.md,
// prototype SOX§101/PCAOB — the auditor itself leaves an auditable trace).
//
// The law: every run records WHICH ruler spoke — the sha256 of every persona
// prompt / criteria text the ballot face actually sends to a model. Without
// it, "re-evaluate this artifact under the new rules" is unreproducible and a
// ruler edit mid-epoch silently changes what old ballots meant.
//
// Components are imported from the single authoritative sources (the same
// constants the runtime sends, never a re-typed copy — L-SINGLE-SOURCE): the
// councilor systems (verdict JSON contract baked in), the architect system,
// the swarm judge system + word contract, and the repair grammar rendered
// against a pinned sentinel `why` (the template is what varies with the ruler;
// the sentinel keeps the hash stable across runs).
//
// rulesHash = sha256 over the canonical (name-sorted) component digest list:
// one comparable number per ruler face. A change to ANY hashed text flips it.

import { createHash } from "node:crypto";

import { COUNCILORS, COUNCILOR_PERSONAS } from "./council/index.ts";
import {
  conPrompt,
  evidencePrompt,
  judgePrompt,
  proPrompt,
  rebuttalPrompt,
  type ChamberConfig,
} from "./chamber/protocol.ts";
import type { SeatPolicy } from "./lane/seating.ts";
import { ARCHITECT_SYSTEM, repairDemand, SWARM_JUDGE_SYSTEM, SWARM_JUDGE_WORD_CONTRACT } from "./personas.ts";
import type { InstrumentRef } from "./state/record.ts";

/** The face shape is the record schema's field type — one name, one source. */
export type InstrumentFace = InstrumentRef;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Sentinel `why` for the repair-grammar component: fixed, never user text. */
const REPAIR_SENTINEL = "<parse-failure-why>";

/** Frozen sentinel run so the chamber role templates render deterministically
 * (the builders mix fixed skeleton + cfg fields; only the skeleton varies with
 * the ruler, so the sentinel pins everything else). Fields the builders never
 * read use the cli.ts lane-seam precedent (null cast, documented there). */
const SENTINEL_CFG: ChamberConfig = {
  runId: "sibyl-sentinel",
  runDir: "/sentinel/run",
  goal: "<goal>",
  targetPath: "/sentinel/target.md",
  ledgerPath: "/sentinel/ledger.jsonl",
  seed: "<seed>",
  maxRounds: 1,
  pool: { default: { providerID: "", modelID: "" } },
  policy: null as unknown as SeatPolicy,
  slots: { evidence: "default", pro: "default", con: "default", judge: "default" },
  judgePoolIds: [],
  lane: null as unknown as ChamberConfig["lane"],
};

function chamberRoleTexts(): Record<string, string> {
  return {
    "chamber-evidence-prompt": evidencePrompt(SENTINEL_CFG, "/sentinel/evidence.jsonl"),
    "chamber-pro-prompt": proPrompt(SENTINEL_CFG, 1, "/sentinel/pro.md", []),
    "chamber-con-prompt": conPrompt(SENTINEL_CFG, 1, "/sentinel/con.md", []),
    "chamber-rebuttal-prompt": rebuttalPrompt(SENTINEL_CFG, "pro", 1, "/sentinel/con.md", "/sentinel/pro-rebuttal.md"),
    "chamber-judge-prompt": judgePrompt(SENTINEL_CFG, 1, ["/sentinel/pro.md", "/sentinel/con.md"], "/sentinel/judge.json"),
  };
}

/** Pinned sentinels + the exact text each role/voter receives. */
function componentTexts(): Record<string, string> {
  const texts: Record<string, string> = {
    "repair-grammar": repairDemand(REPAIR_SENTINEL),
    "swarm-judge-system": SWARM_JUDGE_SYSTEM,
    "swarm-judge-word-contract": SWARM_JUDGE_WORD_CONTRACT,
    ...chamberRoleTexts(),
  };
  for (const id of COUNCILORS) {
    texts[`councilor-${id.toLowerCase()}`] = COUNCILOR_PERSONAS[id].system;
  }
  texts["architect-system"] = ARCHITECT_SYSTEM;
  return texts;
}

let cached: InstrumentFace | null = null;

/** Deterministic face of the ruler code compiled into this build. */
export function instrumentFace(): InstrumentFace {
  if (cached !== null) return cached;
  const components: Record<string, string> = {};
  for (const [name, text] of Object.entries(componentTexts())) {
    components[name] = sha256Hex(text);
  }
  const canonical = JSON.stringify(
    Object.keys(components)
      .sort()
      .map((name) => [name, components[name]]),
  );
  cached = { rulesHash: sha256Hex(canonical), components };
  return cached;
}

/** Compact ballot-face rendering: rules=<first 12 hex>. */
export function rulesLabel(face: InstrumentFace): string {
  return `rules=${face.rulesHash.slice(0, 12)}`;
}
