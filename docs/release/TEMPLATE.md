# release packet — <version>

(one-line summary of what ships)

gate: <PASS or FAIL — write the REAL gate verdict here; the literal placeholder never passes>

## gate transcript
- tests: <full-suite verbatim tail>
- machine-path scan: <command + clean result>
- secret scan: <command + clean result>
- content-identity receipt (owner ruling 2026-10-09): after committing this packet, run
  `git diff --stat <gate-scan-head>..<release-commit>` and paste the output here — the
  delta must contain ONLY the expected release files (bump + this receipt). A dirty tree
  at scan time is no longer taken on trust; the diff proves the scanned bytes are the
  shipped bytes.
- gate report anchor: absolute path or repo-root-anchored path + sha256 of the report
  file, recorded the same turn the gate runs (a bare relative path is not an anchor).

## human approval
- the terminal-side confirmation key stays human-only
