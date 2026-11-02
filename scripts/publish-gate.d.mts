export type GateRun = { id: number; event: string; status: string; conclusion: string | null; head_sha: string; created_at: string };
export function evaluate(
  runs: readonly GateRun[],
  headSha: string,
  nowMs: number,
  opts: { intervalDays: number; capDays: number },
): { verdict: "PASS" | "FAIL"; why: string };
