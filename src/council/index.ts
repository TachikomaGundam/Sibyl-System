// provenance: original clean-room Sibyl-System implementation (plan task 4 — council
// layer). No code copied from the swarm project.
//
// Pure vote aggregation over parsed verdicts: ZERO session/IO/LLM calls here
// (engine/tools own those). The three fixed councilor personas carry the exact
// JSON output contract that the verdict layer (src/verdict/) parses.
//
// USER-PINNINED RULE (plan Scope 2, non-negotiable): the council is
// fail-closed — any tie / missing(veto null) / error vote makes a full APPROVE
// impossible. A "lenient" mode is deliberately NOT provided and must never be
// added.

import type { Verdict } from "../verdict/index.ts";

export const COUNCILORS = ["MELCHIOR", "BALTHASAR", "CASPER"] as const;
export type CouncilorId = (typeof COUNCILORS)[number];

/**
 * Ballot payload = the verdict layer's `Verdict` (T8 wiring: the local
 * structural twin authored before src/verdict existed is replaced by the real
 * import; shapes were verbatim-compatible, so no behavior changes). The
 * runtime gate isWellFormedVerdict below stays: the council still sits
 * downstream of untrusted upstreams and demotes malformed payloads to
 * fail-closed error votes instead of trusting types alone.
 */
export type VoteVerdict = Verdict;

/** One councilor's ballot: a parsed verdict, a call error, or silence. */
export type CouncilVote =
  | { id: CouncilorId; ok: true; verdict: VoteVerdict }
  | { id: CouncilorId; ok: false; error: string }
  | { id: CouncilorId; missing: true };

export type TallyResult = {
  verdict: "APPROVE" | "REJECT";
  approvals: number;
  rejects: number;
  errors: number;
  missing: number;
  policy: string;
  votes: CouncilVote[];
  reasons: string[];
  must_fix: string[];
};

export type TallyPolicy = {
  name: string;
  decide(votes: CouncilVote[]): TallyResult;
};

// --- personas ---------------------------------------------------------------

// The sentence each persona MUST satisfy so the verdict parser can do its job:
// exactly one JSON object, nothing else. Kept aligned with plan Scope 2:
// {verdict: APPROVE|REJECT, confidence 0-1, reasons[], must_fix[]}.
const OUTPUT_CONTRACT =
  'Respond with EXACTLY one JSON object and nothing else - no prose, no markdown fences, no extra keys - ' +
  'matching: {"verdict":"APPROVE"|"REJECT","confidence":<number between 0 and 1>,' +
  '"reasons":[<strings>],"must_fix":[<strings>]}. ' +
  '"verdict" is your final ballot, "confidence" your certainty (0..1), "reasons" the justification, ' +
  '"must_fix" the concrete defects that block approval (empty array if none).';

export const COUNCILOR_PERSONAS: Record<CouncilorId, { title: string; system: string }> = {
  MELCHIOR: {
    title: "correctness & safety skeptic",
    system:
      "You are MELCHIOR, the correctness-and-safety skeptic on the SIBYL council. " +
      "Audit the artifact for logical errors, unproven assumptions, correctness bugs, safety hazards, " +
      "and irreversible side effects. Approve only if it survives strict technical scrutiny; default to " +
      "REJECT when doubt remains. " +
      OUTPUT_CONTRACT,
  },
  BALTHASAR: {
    title: "adversarial red-teamer",
    system:
      "You are BALTHASAR, the adversarial red-teamer on the SIBYL council. " +
      "Attack the artifact as an adversary: probe abuse cases, exploits, race conditions, input-boundary " +
      "failures, and ways it breaks under hostile use. If you can name a concrete attack or failure mode, " +
      "REJECT and put it in must_fix. " +
      OUTPUT_CONTRACT,
  },
  CASPER: {
    title: "pragmatic utilist",
    system:
      "You are CASPER, the pragmatic utilist on the SIBYL council. " +
      "Judge the artifact by real-world utility: does it solve the stated problem, is it maintainable, " +
      "worth the complexity, and shippable? Weigh benefit against cost, but REJECT when the defects " +
      "outweigh the value. " +
      OUTPUT_CONTRACT,
  },
};

// --- internals --------------------------------------------------------------

const COUNCIL_SIZE = COUNCILORS.length; // 3
const KNOWN_IDS: ReadonlySet<string> = new Set<string>(COUNCILORS);

type TallyCounts = {
  approvals: number;
  rejects: number;
  errors: number;
  missing: number;
};

type Ballots = TallyCounts & {
  /** Fail-closed explanations contributed by error/missing votes, voter order. */
  notes: string[];
  /** Raw reasons/must_fix of all present votes, voter order (pre-dedupe). */
  reasons: string[];
  mustFix: string[];
};

/**
 * Deterministic structural gate. Violations are impossible for typed callers
 * but must fail closed for untrusted upstream ones: wrong size, unknown id,
 * duplicate id, or out-of-canonical-order ids all yield a REJECT reason
 * (never a throw). Check order is fixed: size -> unknown -> duplicate -> order.
 */
function structuralIssue(votes: readonly CouncilVote[]): string | null {
  if (votes.length !== COUNCIL_SIZE) {
    return `invalid council size: expected ${COUNCIL_SIZE} votes, got ${votes.length} (fail-closed REJECT)`;
  }
  const seen = new Set<string>();
  for (const vote of votes) {
    if (!KNOWN_IDS.has(vote.id)) {
      return `unknown councilor id "${vote.id}" (fail-closed REJECT)`;
    }
    if (seen.has(vote.id)) {
      return `duplicate councilor id "${vote.id}" (fail-closed REJECT)`;
    }
    seen.add(vote.id);
  }
  let index = 0;
  for (const expectedId of COUNCILORS) {
    const actual = votes[index];
    if (actual === undefined || actual.id !== expectedId) {
      const got = votes.map((v) => v.id).join(",");
      return `councilor order must be ${COUNCILORS.join(",")}, got ${got} (fail-closed REJECT)`;
    }
    index += 1;
  }
  return null;
}

/**
 * Runtime shape check of an ok:true ballot payload against the Scope-2 JSON
 * contract. Typed callers get this from the verdict parser for free, but the
 * council sits downstream of untrusted upstreams, so a payload failing this
 * check is demoted to an error vote (fail-closed) instead of throwing.
 */
function isWellFormedVerdict(payload: unknown): payload is VoteVerdict {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  return (
    "verdict" in payload &&
    (payload.verdict === "APPROVE" || payload.verdict === "REJECT") &&
    "confidence" in payload &&
    typeof payload.confidence === "number" &&
    Number.isFinite(payload.confidence) &&
    "reasons" in payload &&
    Array.isArray(payload.reasons) &&
    payload.reasons.every((entry: unknown) => typeof entry === "string") &&
    "must_fix" in payload &&
    Array.isArray(payload.must_fix) &&
    payload.must_fix.every((entry: unknown) => typeof entry === "string")
  );
}

/**
 * Single pass over the ballots. Merge semantics (documented decision):
 * reasons/must_fix of EVERY present (ok:true) vote are merged - regardless of
 * that voter's own ballot, so a REJECT voter's must_fix items still reach the
 * author - in voter order; error/missing votes contribute fail-closed notes
 * only. A vote whose payload fails isWellFormedVerdict counts as an error vote
 * and contributes no notes. Any well-formed ballot value other than "APPROVE"
 * counts as a reject (fail-closed).
 */
function inspect(votes: readonly CouncilVote[]): Ballots {
  let approvals = 0;
  let rejects = 0;
  let errors = 0;
  let missing = 0;
  const notes: string[] = [];
  const reasons: string[] = [];
  const mustFix: string[] = [];
  for (const vote of votes) {
    if ("missing" in vote) {
      missing += 1;
      notes.push(`${vote.id} returned no verdict (missing) - fail-closed`);
    } else if (!vote.ok) {
      errors += 1;
      notes.push(`${vote.id} errored: ${vote.error} - fail-closed`);
    } else if (!isWellFormedVerdict(vote.verdict)) {
      errors += 1;
      notes.push(`${vote.id} malformed verdict payload - fail-closed`);
    } else {
      if (vote.verdict.verdict === "APPROVE") {
        approvals += 1;
      } else {
        rejects += 1;
      }
      reasons.push(...vote.verdict.reasons);
      mustFix.push(...vote.verdict.must_fix);
    }
  }
  return { approvals, rejects, errors, missing, notes, reasons, mustFix };
}

function dedupePreserveOrder(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** Shared execution core: structural gate -> count -> predicate -> result. */
function runPolicy(
  votes: readonly CouncilVote[],
  policyName: string,
  canApprove: (counts: TallyCounts) => boolean,
): TallyResult {
  const observed = inspect(votes);
  const issue = structuralIssue(votes);
  const approve = issue === null && canApprove(observed);
  const reasons: string[] = [];
  if (issue !== null) {
    reasons.push(issue);
  }
  reasons.push(...observed.notes);
  if (!approve) {
    reasons.push(
      `policy ${policyName} did not reach approval: ${observed.approvals}/${COUNCIL_SIZE} approvals, ` +
        `${observed.errors} error, ${observed.missing} missing (fail-closed REJECT)`,
    );
  }
  reasons.push(...dedupePreserveOrder(observed.reasons));
  return {
    verdict: approve ? "APPROVE" : "REJECT",
    approvals: observed.approvals,
    rejects: observed.rejects,
    errors: observed.errors,
    missing: observed.missing,
    policy: policyName,
    votes: [...votes],
    reasons,
    must_fix: dedupePreserveOrder(observed.mustFix),
  };
}

// --- policies ---------------------------------------------------------------

/**
 * Default: >=2 approvals AND zero error/missing votes. With a valid 3-vote
 * structure this admits exactly {2A+1R, 3A}. USER-PINNINED fail-closed: any
 * error or missing vote blocks APPROVE even alongside 2 approvals
 * (2A+1E -> REJECT, 2A+1M -> REJECT, 1A+1R+1E tie -> REJECT).
 */
export const majority2of3: TallyPolicy = {
  name: "majority2of3",
  decide(votes: CouncilVote[]): TallyResult {
    return runPolicy(votes, "majority2of3", (t) => t.approvals >= 2 && t.errors === 0 && t.missing === 0);
  },
};

/** Reserved export (plan task 4): all three APPROVE, no errors/missing. */
export const unanimous: TallyPolicy = {
  name: "unanimous",
  decide(votes: CouncilVote[]): TallyResult {
    return runPolicy(
      votes,
      "unanimous",
      (t) => t.approvals === COUNCIL_SIZE && t.errors === 0 && t.missing === 0,
    );
  },
};

/** Pure tally entry point; defaults to the user-pinned fail-closed majority2of3. */
export function tallyVotes(votes: CouncilVote[], policy: TallyPolicy = majority2of3): TallyResult {
  return policy.decide(votes);
}
