// provenance: original clean-room scaffold, no external code copied.
//
// Smoke test for the T1 scaffold: proves the .ts test mechanism works
// (node --test running .ts files that import other .ts files via relative
// ".ts"-extension specifiers). Since the opencode 2.x migration the import
// chain test -> src/index.ts must resolve with ZERO @opencode-ai packages in
// node_modules (src is structural-typed, see src/v2/types.ts); this file and
// test/entry.test.ts together pin that guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";

import SibylPlugin from "../src/index.ts";

test("scaffold: plugin default export is a V2 {id, setup} object", () => {
  assert.equal(typeof SibylPlugin, "object");
  assert.equal(typeof SibylPlugin.id, "string");
  assert.equal(typeof SibylPlugin.setup, "function");
});
