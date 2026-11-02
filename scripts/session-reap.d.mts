export type ReapSession = { id: string; title: string; parentID: string | null; created?: number; updated: number };
export type ReapAction = { id: string; title: string; action: "delete" | "keep"; reason: string; ageDays: number; created: number; parentNull: boolean };
export function classify(
  sessions: readonly ReapSession[],
  opts: { nowMs: number; tierADays: number; tierBDays?: number | null; ownerRuling?: boolean; keepRe?: RegExp | null },
): ReapAction[];
export function enumerate(dbPath: string): ReapSession[];
