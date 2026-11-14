export type SweepDir = { name: string; uidOk: boolean; sealed: boolean; terminal: boolean; ageMs: number };
export type SweepAction = { name: string; action: "move" | "keep"; reason: string };
export function planSweep(dirs: readonly SweepDir[], opts: { olderThanMs: number }): SweepAction[];
/** move with EXDEV fallback; collision gets a .dup-<ts> suffix; returns dest. */
export function moveDir(src: string, destRoot: string, nowMs?: number): Promise<string>;
export function main(stdout?: { log(...args: unknown[]): void }): Promise<{ moved: string[] }>;
