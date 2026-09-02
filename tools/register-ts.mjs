// provenance: original clean-room scaffold, no external code copied
//
// Registers the esbuild-backed ".ts" ESM loader hook so `node --test` can run
// TypeScript test files directly (this Node v22.22.1 build is compiled without
// native type-stripping: ERR_NO_TYPESCRIPT). Used via:
//   node --import ./tools/register-ts.mjs --test test/*.test.ts
// See package.json "test" script and learnings.md for the contract.
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
