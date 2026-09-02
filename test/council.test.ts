// provenance: original clean-room Sibyl-System implementation (plan task 4 - council
// layer tests). Exhaustive 4^3 vote matrix + targeted fail-closed rows +
// merge-semantics + adversarial structural input + determinism.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COUNCILORS,
  COUNCILOR_PERSONAS,
  majority2of3,
  unanimous,
  tallyVotes,
} from "../src/council/index.ts";
import type { CouncilorId, CouncilVote, VoteVerdict } from "../src/council/index.ts";

// --- fixtures -----------------------------------------------------------------

type Cell = "APPROVE" | "REJECT" | "ERROR" | "MISSING";
const CELLS: readonly Cell[] = ["APPROVE", "REJECT", "ERROR", "MISSING"];

function verdictFor(kind: "APPROVE" | "REJECT", seed: string): VoteVerdict {
  return {
    verdict: kind,
    confidence: 0.7,
    reasons: [`${seed} reason`],
    must_fix: [`${seed} fix`],
  };
}

function voteFor(id: CouncilorId, cell: Cell): CouncilVote {
  switch (cell) {
    case "APPROVE":
      return { id, ok: true, verdict: verdictFor("APPROVE", id) };
    case "REJECT":
      return { id, ok: true, verdict: verdictFor("REJECT", id) };
    case "ERROR":
      return { id, ok: false, error: `boom:${id}` };
    case "MISSING":
      return { id, missing: true };
  }
}

function ballot(a: Cell, b: Cell, c: Cell): CouncilVote[] {
  const [melchior, balthasar, casper] = COUNCILORS;
  return [voteFor(melchior, a), voteFor(balthasar, b), voteFor(casper, c)];
}

function countCells(cells: readonly Cell[], wanted: Cell): number {
  return cells.filter((cell) => cell === wanted).length;
}

// --- personas -----------------------------------------------------------------

test("council: COUNCILORS is the fixed SIBYL trio in canonical order", () => {
  assert.deepEqual([...COUNCILORS], ["MELCHIOR", "BALTHASAR", "CASPER"]);
});

test("council: every persona covers its id and demands the exact JSON contract", () => {
  assert.deepEqual(Object.keys(COUNCILOR_PERSONAS).sort(), [...COUNCILORS].sort());
  for (const id of COUNCILORS) {
    const persona = COUNCILOR_PERSONAS[id];
    assert.ok(persona.title.length > 0, `${id} title`);
    // Machine-consumed structural tokens of the verdict-parser contract
    // (plan Scope 2): assert key names exist, never prose wording.
    for (const token of ['"verdict"', '"APPROVE"', '"REJECT"', '"confidence"', '"reasons"', '"must_fix"']) {
      assert.ok(persona.system.includes(token), `${id} system must demand ${token}`);
    }
  }
});

// --- exhaustive 4^3 matrix ------------------------------------------------------

test("council: all 64 vote combinations tally fail-closed - APPROVE only when >=2 approvals and 3rd is REJECT", () => {
  let approveCells = 0;
  let visited = 0;
  for (const a of CELLS) {
    for (const b of CELLS) {
      for (const c of CELLS) {
        visited += 1;
        const cells: Cell[] = [a, b, c];
        const result = tallyVotes(ballot(a, b, c));
        const approvals = countCells(cells, "APPROVE");
        const rejects = countCells(cells, "REJECT");
        const errors = countCells(cells, "ERROR");
        const missing = countCells(cells, "MISSING");
        // Expected derived from the combinatorial semantics of the user-pinned
        // rule: >=2 approvals AND every seat present (no error/missing), i.e.
        // the non-approvals are plain REJECT votes.
        const expected = approvals >= 2 && approvals + rejects === 3 ? "APPROVE" : "REJECT";
        assert.equal(result.verdict, expected, `cells ${a}/${b}/${c}`);
        assert.equal(result.approvals, approvals);
        assert.equal(result.rejects, rejects);
        assert.equal(result.errors, errors);
        assert.equal(result.missing, missing);
        assert.equal(result.policy, "majority2of3");
        assert.equal(result.votes.length, 3);
        if (expected === "APPROVE") {
          approveCells += 1;
        }
      }
    }
  }
  assert.equal(visited, 64);
  // Combinatorial ground truth: C(3,2)=3 two-approval patterns + 1 three-approval.
  assert.equal(approveCells, 4);
});

// --- targeted fail-closed rows (USER-PINNINED, asserted literally) -------------

test("council: 3 approvals approve under majority2of3", () => {
  const result = tallyVotes(ballot("APPROVE", "APPROVE", "APPROVE"));
  assert.equal(result.verdict, "APPROVE");
});

test("council: 2 approvals + 1 error reject (fail-closed, lenient mode forbidden)", () => {
  const result = tallyVotes(ballot("APPROVE", "APPROVE", "ERROR"));
  assert.equal(result.verdict, "REJECT");
  assert.equal(result.approvals, 2);
  assert.equal(result.errors, 1);
});

test("council: 2 approvals + 1 missing reject (fail-closed)", () => {
  const result = tallyVotes(ballot("APPROVE", "MISSING", "APPROVE"));
  assert.equal(result.verdict, "REJECT");
  assert.equal(result.missing, 1);
});

test("council: 1-1 tie with error vote reject", () => {
  const result = tallyVotes(ballot("APPROVE", "REJECT", "ERROR"));
  assert.equal(result.verdict, "REJECT");
});

test("council: 2 approvals + 1 reject approve (all three present)", () => {
  const result = tallyVotes(ballot("REJECT", "APPROVE", "APPROVE"));
  assert.equal(result.verdict, "APPROVE");
});

test("council: no votes present reject", () => {
  const result = tallyVotes(ballot("MISSING", "ERROR", "MISSING"));
  assert.equal(result.verdict, "REJECT");
  assert.equal(result.approvals, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.missing, 2);
});

test("council: empty vote list reject fail-closed, never throws", () => {
  const result = tallyVotes([]);
  assert.equal(result.verdict, "REJECT");
  assert.match(result.reasons[0] ?? "", /invalid council size/);
});

// --- merge semantics ------------------------------------------------------------

test("council: merges reasons/must_fix of ALL present votes regardless of ballot, voter order, de-duplicated", () => {
  const votes: CouncilVote[] = [
    {
      id: "MELCHIOR",
      ok: true,
      verdict: {
        verdict: "APPROVE",
        confidence: 0.9,
        reasons: ["m reason", "shared reason"],
        must_fix: ["m fix", "shared fix"],
      },
    },
    {
      // A REJECT voter's notes still reach the author (documented merge rule).
      id: "BALTHASAR",
      ok: true,
      verdict: {
        verdict: "REJECT",
        confidence: 0.6,
        reasons: ["shared reason", "b reason"],
        must_fix: ["shared fix", "b fix"],
      },
    },
    { id: "CASPER", ok: false, error: "timeout" },
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT"); // 1 approval + 1 error -> fail-closed
  // Voter-order first-occurrence dedupe; error/missing fail-closed notes lead.
  assert.deepEqual(
    result.reasons.filter((r) => !r.startsWith("CASPER") && !r.startsWith("policy ")),
    ["m reason", "shared reason", "b reason"],
  );
  assert.deepEqual(result.must_fix, ["m fix", "shared fix", "b fix"]);
  assert.ok(result.reasons.some((r) => r.includes("CASPER errored: timeout")));
});

// --- adversarial structural input ------------------------------------------------

test("council: out-of-order ids reject deterministically", () => {
  const votes: CouncilVote[] = [
    voteFor("BALTHASAR", "APPROVE"),
    voteFor("MELCHIOR", "APPROVE"),
    voteFor("CASPER", "APPROVE"),
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT");
  assert.match(result.reasons[0] ?? "", /councilor order must be MELCHIOR,BALTHASAR,CASPER/);
});

test("council: duplicate ids reject deterministically", () => {
  const votes: CouncilVote[] = [
    voteFor("MELCHIOR", "APPROVE"),
    voteFor("MELCHIOR", "APPROVE"),
    voteFor("CASPER", "APPROVE"),
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT");
  assert.match(result.reasons[0] ?? "", /duplicate councilor id "MELCHIOR"/);
});

test("council: unknown id rejects deterministically (cast: runtime value the types forbid)", () => {
  const votes: CouncilVote[] = [
    voteFor("MELCHIOR", "APPROVE"),
    // Adversarial untrusted-upstream simulation: an id outside CouncilorId is
    // unrepresentable in typed callers, so the runtime guard is proven here.
    { id: "SHAZAM", missing: true } as unknown as CouncilVote,
    voteFor("CASPER", "APPROVE"),
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT");
  assert.match(result.reasons[0] ?? "", /unknown councilor id "SHAZAM"/);
});

test("council: oversized ballot (4 votes) reject, never throws", () => {
  const votes: CouncilVote[] = [
    ...ballot("APPROVE", "APPROVE", "APPROVE"),
    voteFor("CASPER", "APPROVE"),
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT");
  assert.match(result.reasons[0] ?? "", /invalid council size: expected 3 votes, got 4/);
});

// --- adversarial malformed payloads (orchestrator probe: must not throw) ----------

test("council: ok:true with garbage/absent verdict payload demotes to error vote, no throw", () => {
  const cases: unknown[] = [
    undefined,
    null,
    "APPROVE",
    {},
    42,
    { verdict: "APPROVE", confidence: 0.5, reasons: "not-an-array", must_fix: [] },
    { verdict: "MAYBE", confidence: 0.5, reasons: [], must_fix: [] },
    { verdict: "APPROVE", confidence: Number.NaN, reasons: [], must_fix: [] },
    { verdict: "APPROVE", confidence: 0.5, reasons: [], must_fix: [{ nested: 1 }] },
  ];
  for (const payload of cases) {
    const votes: CouncilVote[] = [
      { id: "MELCHIOR", ok: true, verdict: payload } as unknown as CouncilVote,
      voteFor("BALTHASAR", "REJECT"),
      voteFor("CASPER", "REJECT"),
    ];
    const result = tallyVotes(votes);
    assert.equal(result.verdict, "REJECT");
    assert.equal(result.errors, 1, `errors for payload ${String(payload)}`);
    assert.equal(result.approvals, 0);
    assert.ok(
      result.reasons.some((r) => r === "MELCHIOR malformed verdict payload - fail-closed"),
      `note for payload ${String(payload)}`,
    );
  }
});

test("council: ok:true with non-array reasons demotes to error vote", () => {
  const malformed = {
    id: "CASPER",
    ok: true,
    verdict: { ...verdictFor("APPROVE", "CASPER"), reasons: "trust me" },
  } as unknown as CouncilVote;
  const result = tallyVotes([voteFor("MELCHIOR", "APPROVE"), voteFor("BALTHASAR", "APPROVE"), malformed]);
  assert.equal(result.verdict, "REJECT");
  assert.equal(result.errors, 1);
  assert.equal(result.approvals, 2);
});

test("council: malformed-payload voter contributes nothing; valid voters still merge in order", () => {
  const votes: CouncilVote[] = [
    voteFor("MELCHIOR", "APPROVE"),
    {
      id: "BALTHASAR",
      ok: true,
      verdict: { verdict: "APPROVE", confidence: 0.9, reasons: undefined },
    } as unknown as CouncilVote,
    {
      id: "CASPER",
      ok: true,
      verdict: { verdict: "REJECT", confidence: 0.4, reasons: ["c reason"], must_fix: ["c fix"] },
    },
  ];
  const result = tallyVotes(votes);
  assert.equal(result.verdict, "REJECT"); // 1 approval + 1 error -> fail-closed
  assert.equal(result.errors, 1);
  assert.equal(result.approvals, 1);
  assert.equal(result.rejects, 1);
  assert.ok(!result.reasons.some((r) => r.includes("BALTHASAR reason")));
  assert.ok(!result.must_fix.some((m) => m.includes("BALTHASAR fix")));
  assert.deepEqual(result.must_fix, ["MELCHIOR fix", "c fix"]);
  assert.ok(
    result.reasons.includes("MELCHIOR reason") &&
      result.reasons.includes("c reason") &&
      result.reasons.indexOf("MELCHIOR reason") < result.reasons.indexOf("c reason"),
  );
});

// --- policies ---------------------------------------------------------------------

test("council: default policy is majority2of3", () => {
  assert.equal(tallyVotes(ballot("APPROVE", "APPROVE", "REJECT")).policy, "majority2of3");
  assert.equal(majority2of3.name, "majority2of3");
});

test("council: unanimous policy approves only all-3 approvals", () => {
  assert.equal(unanimous.name, "unanimous");
  assert.equal(tallyVotes(ballot("APPROVE", "APPROVE", "APPROVE"), unanimous).verdict, "APPROVE");
  const split = tallyVotes(ballot("APPROVE", "APPROVE", "REJECT"), unanimous);
  assert.equal(split.verdict, "REJECT");
  assert.equal(split.policy, "unanimous");
  assert.equal(tallyVotes(ballot("APPROVE", "APPROVE", "ERROR"), unanimous).verdict, "REJECT");
});

// --- determinism --------------------------------------------------------------------

test("council: same input 100x produces identical output", () => {
  const votes = ballot("APPROVE", "REJECT", "ERROR");
  const first = tallyVotes(votes);
  for (let i = 0; i < 100; i += 1) {
    assert.deepStrictEqual(tallyVotes(votes), first);
  }
  const approveVotes = ballot("APPROVE", "APPROVE", "REJECT");
  const firstApprove = tallyVotes(approveVotes);
  for (let i = 0; i < 100; i += 1) {
    assert.deepStrictEqual(tallyVotes(approveVotes), firstApprove);
  }
});
