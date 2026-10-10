# release packet — <version>

(one-line summary of what ships)

gate: <PASS or FAIL — write the REAL gate verdict here; the literal placeholder never passes>

## gate transcript
- tests: <full-suite verbatim tail>
- machine-path scan: <command + clean result>
- secret scan: <command + clean result>
- content-identity receipt (amended by ballot 49d5, 2026-10-10): sequence is
  commit -> `git diff --stat <base>..<commit>` -> paste REAL output into this packet ->
  amend -> tag. The tag body must never contain a 'pending' placeholder for a proof the
  seat can already produce. Delta must contain ONLY the expected release files.
- gate evidence permanence: copy the gate report AND each leg's log into the repo's
  tracked evidence dir (.omo/evidence/<wheel>/...) in the generating turn, and anchor
  this packet to those paths + sha256. tmpfs is not a receipt home — an anchor that
  dies with a reboot is an unfalsifiable receipt (ballot 49d5, confirmed defect).
- release-boundary manifest: `git log --oneline <previous-tag>..<new-commit>` in full —
  the packet states its whole shipped delta, not only the wheel commit.

## human approval
- the terminal-side confirmation key stays human-only

## pre-push blind audit (ballot 49d5 law)
- before the human push, run the outside lane on THIS final packet
  (`opencode run --agent build` calling sibyl_audit); an EFFECTIVE REJECT must be
  fixed before the tag ships. Post-publish self-audit stays as backstop, not gate.
