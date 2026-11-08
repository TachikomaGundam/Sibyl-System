export type GateRun = { id: number; event: string; status: string; conclusion: string | null; head_sha: string; head_branch: string; created_at: string };
export type GateOpts = {
  intervalDays: number;
  capDays: number;
  defaultBranch?: string;
  /** release-day auto-witness (H1): when set, the door waits for an audit
   * causally tied to THIS tag (push witness on head_branch===tagRef, or a
   * default-branch run created at/after tagRefCreatedAtMs), never "latest green". */
  tagRef?: string;
  tagRefCreatedAtMs?: number;
  deadlineMs?: number;
  pollSeconds?: number;
  waitMinutes?: number;
};
export function evaluate(
  runs: readonly GateRun[],
  headSha: string,
  nowMs: number,
  opts: GateOpts,
): { verdict: "PASS" | "FAIL" | "WAIT"; why: string };

export const DEFAULT_WORKFLOW: string;
export const DEFAULTS: { intervalDays: number; capDays: number; pollSeconds: number; waitMinutes: number };
