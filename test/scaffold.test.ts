// provenance: original clean-room scaffold, no external code copied
//
// Smoke test for the T1 scaffold: proves the .ts test mechanism works
// (node --test running .ts files that import other .ts files via relative
// ".ts"-extension specifiers) and that the import chain
// test -> src/index.ts -> "@opencode-ai/plugin" resolves from <repo>/node_modules.

import { test } from "node:test";
import assert from "node:assert/strict";

import SibylPlugin from "../src/index.ts";

test("scaffold: plugin default export is an async function", () => {
  assert.equal(typeof SibylPlugin, "function");
});
