// v1.5.0 single-source util: errMessage/withTimeout behaviour locked here —
// the former three/two copies (engine, options, tools/shared) now import
// these definitions, so this file is their regression home.

import { test } from "node:test";
import assert from "node:assert/strict";

import { errMessage, withTimeout } from "../src/util.ts";

test("errMessage: Error → message, string → itself", () => {
  assert.equal(errMessage(new Error("boom")), "boom");
  assert.equal(errMessage("plain"), "plain");
});

test("errMessage: object errors JSON.stringify (never [object Object])", () => {
  assert.equal(errMessage({ code: "E" }), '{"code":"E"}');
  assert.equal(errMessage(undefined), "undefined");
});

test("errMessage: throwing stringify falls back to String", () => {
  const hostile = { get a(): number { throw new Error("trap"); } };
  assert.equal(typeof errMessage(hostile), "string");
});

test("withTimeout: resolves in time; timer cleared (process exits)", async () => {
  const v = await withTimeout(Promise.resolve(7), 1_000, "unit");
  assert.equal(v, 7);
});

test("withTimeout: expiry rejects with the label+ms timeout grammar", async () => {
  await assert.rejects(
    withTimeout(new Promise((res) => setTimeout(res, 50)), 5, "session.prompt"),
    /session\.prompt timeout after 5ms/,
  );
});
