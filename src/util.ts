// provenance: v1.5.0 L-SINGLE-SOURCE consolidation (2026-10-24 wheel, queue item 2
// of HANDOFF-SIBYL-20261023.md §3): withTimeout existed twice (engine/index.ts and
// tools/shared.ts), the unknown-error renderer existed three times (engine
// describeError, options describeError, tools errMessage). Behaviour is UNCHANGED —
// this module is the one definition each former copy now imports.

/**
 * Render an unknown error value as a stable string. Error → .message,
 * string → itself, anything else JSON.stringify'd (an object error stringifies
 * to "[object Object]" via String() and would erase the evidence), and a
 * throwing stringify falls back to String(). Never throws.
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    return json === undefined ? String(err) : json;
  } catch {
    return String(err);
  }
}

/**
 * Promise.race guard with the timer cleared in finally (spike probe
 * server.js:23-31 pattern). On expiry the race rejects with an Error whose
 * message is "<label> timeout after <ms>ms" — callers match "timeout" to map
 * the rejection onto a structured failure (and the engine's salvage regex
 * treats it as transport-class).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
