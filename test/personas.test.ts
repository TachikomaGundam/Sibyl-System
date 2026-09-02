// provenance: original clean-room Sibyl-System implementation (plan task 6 - persona
// registry tests). Registry coverage, councilor prompt reuse (identity against
// the imported COUNCILOR_PERSONAS), architect strict-JSON contract tokens, and
// resolvePersona fail-soft behavior on hostile input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCILORS, COUNCILOR_PERSONAS } from "../src/council/index.ts";
import { PERSONAS, PERSONA_IDS, resolvePersona } from "../src/personas.ts";
import type { Persona, PersonaId } from "../src/personas.ts";

const ALL_IDS: readonly PersonaId[] = ["MELCHIOR", "BALTHASAR", "CASPER", "ARCHITECT"];

function requirePersona(id: PersonaId): Persona {
  const persona = resolvePersona(id);
  assert.ok(persona, `persona ${id} must resolve`);
  return persona;
}

test("personas: registry exposes exactly the 3 councilors + ARCHITECT", () => {
  assert.deepEqual([...PERSONA_IDS], [...COUNCILORS, "ARCHITECT"]);
  assert.deepEqual(Object.keys(PERSONAS).sort(), [...ALL_IDS].sort());
});

test("personas: every registry entry is self-consistent (id field matches key, unique slots)", () => {
  const slots = new Set<string>();
  for (const id of ALL_IDS) {
    const persona = PERSONAS[id];
    assert.equal(persona.id, id);
    assert.ok(persona.title.length > 0, `${id} title`);
    assert.ok(persona.system.length > 0, `${id} system`);
    assert.ok(persona.modelSlot.length > 0, `${id} modelSlot`);
    assert.ok(!slots.has(persona.modelSlot), `slot ${persona.modelSlot} duplicated`);
    slots.add(persona.modelSlot);
  }
});

test("personas: councilor entries reuse COUNCILOR_PERSONAS title+system verbatim", () => {
  for (const id of COUNCILORS) {
    const persona = requirePersona(id);
    const source = COUNCILOR_PERSONAS[id];
    assert.equal(persona.title, source.title, `${id} title drift`);
    assert.equal(persona.system, source.system, `${id} system drift`);
  }
});

test("personas: ARCHITECT system demands EXACTLY one JSON workflow object, no prose/fences", () => {
  const system = requirePersona("ARCHITECT").system;
  assert.match(system, /^You are ARCHITECT/);
  assert.match(system, /EXACTLY one JSON object and nothing else/);
  assert.match(system, /no prose, no markdown fences, no extra keys/);
  for (const key of ['"tasks"', '"id"', '"title"', '"instructions"', '"dependsOn"', '"concurrency"', '"notes"']) {
    assert.ok(system.includes(key), `architect contract missing ${key}`);
  }
});

test("personas: resolvePersona returns the same registry instance (no copies)", () => {
  for (const id of ALL_IDS) {
    assert.equal(resolvePersona(id), PERSONAS[id]);
  }
});

test("personas: resolvePersona(unknown id) -> null, never throws", () => {
  for (const bad of ["NOPE", "", "melchior", "architect", "MELCHIOR ", "../etc"]) {
    assert.equal(resolvePersona(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test("personas: resolvePersona(non-string) -> null, never throws (fail-soft config seam)", () => {
  const hostile: readonly unknown[] = [undefined, null, 42, Number.NaN, true, {}, [], () => undefined, Symbol("s")];
  for (const value of hostile) {
    assert.doesNotThrow(() => resolvePersona(value));
    assert.equal(resolvePersona(value), null);
  }
});
