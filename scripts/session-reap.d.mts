export type ReapSession = { id: string; title: string; parentID: string | null; created?: number; updated: number };
export type ReapAction = { id: string; title: string; action: "delete" | "keep"; reason: string; ageDays: number; created: number; parentNull: boolean };
export function classify(
  sessions: readonly ReapSession[],
  opts: { nowMs: number; tierADays: number; tierBDays?: number | null; ownerRuling?: boolean; keepRe?: RegExp | null },
): ReapAction[];
export function enumerate(dbPath: string): ReapSession[];
export function deleteSession(bin: string, id: string, timeoutMs?: number): Promise<boolean>;
/** H2 frozen-manifest input reader (manifest rows + DEAD-LETTER rows). */
export function readDeleteSet(path: string, readText?: string | null): { id: string; source: "manifest" | "dead-letter" }[];
/** Child-first deletion order over the live parent graph. */
export function orderChildFirst(ids: readonly string[], parentById: Map<string, string | null>): string[];
