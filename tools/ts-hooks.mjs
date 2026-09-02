// provenance: original clean-room scaffold, no external code copied
//
// ESM loader hook: transpiles any local file ending in ".ts" with esbuild
// (loader: "ts" = type-stripping, same semantics the native Node TypeScript
// support would provide) and hands the resulting ESM to Node. Relative
// imports from .ts files MUST carry the explicit ".ts" extension (NodeNext +
// allowImportingTsExtensions; this matches tsconfig.json).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts")) {
    return nextLoad(url, context);
  }
  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcefile: path,
  });
  return { format: "module", shortCircuit: true, source: code };
}
