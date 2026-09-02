// provenance: original clean-room Sibyl-System implementation (plan task 6), no swarm code copied.
//
// Persona registry: the three fixed councilors (title + system IMPORTED from
// src/council/index.ts - never re-typed here) plus the ARCHITECT planner
// persona used by the workflow-decomposition layer. Pure data + lookup; zero
// IO, zero sessions. `resolvePersona` is fail-soft: unknown or even non-string
// input returns null and NEVER throws (config-time callers must not be able to
// crash the host through a bad id).

import { COUNCILORS, COUNCILOR_PERSONAS } from "./council/index.ts";
import type { CouncilorId } from "./council/index.ts";

/** Every registrable persona id: the SIBYL trio plus the architect planner. */
export type PersonaId = CouncilorId | "ARCHITECT";

/**
 * One planner/councilor entry.
 * - `id`: stable registry key (what resolvePersona / options.voters use).
 * - `title`: short human description.
 * - `system`: full system prompt (councilor prompts include the verdict JSON
 *   contract baked into src/council; ARCHITECT includes the workflow-schema
 *   contract below).
 * - `modelSlot`: preferred model-pool slot name. At wiring time (T8) the
 *   resolution order is: options.voters[id]/swarm slot override -> this slot ->
 *   pool["default"], so a missing pool entry is never fatal.
 */
export type Persona = {
  readonly id: PersonaId;
  readonly title: string;
  readonly system: string;
  readonly modelSlot: string;
};

// The architect's sentence, mirroring the council's OUTPUT_CONTRACT style in
// src/council/index.ts: one JSON object, nothing else, exact keys.
const ARCHITECT_OUTPUT_CONTRACT =
  'Respond with EXACTLY one JSON object and nothing else - no prose, no markdown fences, no extra keys - ' +
  'matching: {"tasks":[{"id":<string>,"title":<string>,"instructions":<string>,' +
  '"dependsOn":[<task id strings>]}],"concurrency":<integer >= 1>,"notes":<string>}. ' +
  '"tasks" are the units of work decomposing the goal, "dependsOn" lists task ids that must finish first, ' +
  '"concurrency" is the maximum number of tasks safe to run in parallel, ' +
  '"notes" carries planning remarks (empty string if none).';

/** ARCHITECT planner system prompt (strict JSON workflow-schema contract). */
export const ARCHITECT_SYSTEM: string =
  "You are ARCHITECT, the SIBYL planning persona. Decompose the given artifact-production goal into a " +
  "dependency-ordered workflow of minimal, independently executable tasks. " +
  ARCHITECT_OUTPUT_CONTRACT;

export const ARCHITECT_PERSONA: Persona = {
  id: "ARCHITECT",
  title: "workflow architect (planner)",
  system: ARCHITECT_SYSTEM,
  modelSlot: "architect",
};

/** Full registry: 3 councilors (personas imported from the council layer) + ARCHITECT. */
export const PERSONAS: Record<PersonaId, Persona> = {
  MELCHIOR: {
    id: "MELCHIOR",
    title: COUNCILOR_PERSONAS.MELCHIOR.title,
    system: COUNCILOR_PERSONAS.MELCHIOR.system,
    modelSlot: "melchior",
  },
  BALTHASAR: {
    id: "BALTHASAR",
    title: COUNCILOR_PERSONAS.BALTHASAR.title,
    system: COUNCILOR_PERSONAS.BALTHASAR.system,
    modelSlot: "balthasar",
  },
  CASPER: {
    id: "CASPER",
    title: COUNCILOR_PERSONAS.CASPER.title,
    system: COUNCILOR_PERSONAS.CASPER.system,
    modelSlot: "casper",
  },
  ARCHITECT: ARCHITECT_PERSONA,
};

/** Canonical registry order (councilor order first, architect last). */
export const PERSONA_IDS: readonly PersonaId[] = [...COUNCILORS, "ARCHITECT"];

const BY_ID: ReadonlyMap<string, Persona> = new Map<string, Persona>(
  PERSONA_IDS.map((id: PersonaId): [string, Persona] => [id, PERSONAS[id]]),
);

/**
 * Look up one persona. Unknown id -> null; non-string input (untrusted config)
 * -> null. Never throws.
 */
export function resolvePersona(id: unknown): Persona | null {
  if (typeof id !== "string") {
    return null;
  }
  return BY_ID.get(id) ?? null;
}
