# SIBYL EVOLUTION DESIGN v1.1 — 民主集中制评审装置（general-purpose review apparatus）

provenance: Abathur seat, session at harness/magi, 2026-09-24. Inputs: SWARM-EVOLUTION-HANDOFF.md
(PCB-Agent/.omo/self-audit/, read-only), SIBYL-HANDOFF.md F1–F7, research SR1–SR4 (same dir),
live boulder 09-18 team-mode failure + b141 three-round convergence exemplars. Human orders
registered verbatim in .omo/evidence/INTENT-LEDGER.md.

## 0. Mission (reconciled)

- O1 (handoff): evolve the swarm/adversarial-evaluation mechanism to serve as the judge
  apparatus for Abathur's self-evolution loop, honoring L1–L7, delivering E1–E6, acceptance A1–A5.
- O2 (human, same day, supersedes narrowness of O1): 进化目标不只是担任阿巴瑟的进化回路评审，是要辅助
  **任何需要评审的地方**进行评审。西比拉系统内部要实现**民主集中制**：内部可以高对抗性密集交锋，从广泛
  的来源获取证据，辩论之后对外统一**一个结论、一个声音**。
- Reconciliation: the chamber (§4) is the general mechanism; Abathur's behavioral exam (§5) is
  ONE consumer profile among {document, code, plan, behavior-exam}. Repo home = harness/magi
  (package `sibyl-system`; harness/swarm stays frozen as the legacy L0 record plugin — E6 resolves
  team_* by RETIREMENT into this chamber design, per its 0-for-2 record + spike-m0 headless NO-GO).

## 1. Standing laws (normative for this repo; violation = test FAILS)

- L1 ISOLATION: every chamber/exam role session runs with dedicated HOME+XDG+OPENCODE_DB under
  /tmp/sibyl-run-<runId>/<role>/home. Human's main opencode.db receives ZERO sessions; acceptance
  measures before/after counts (read-only query) and reports.
- L2 USER-SPACE HARD READ-ONLY: never write ~/.bashrc, ~/.profile, PATH, ~/.local/bin, and never
  route around kernel +i locks. (Note: chamber config lives in THIS repo + plugin options only.)
- L3 NO OUT-OF-BAND CALLING: orchestration inside opencode framework — `opencode run` children
  are in-framework (human's own bench uses it); no wrappers/aliases/startup modifications.
- L4 PROCESS DISCIPLINE: kill ONLY by explicit numeric PID read from the run's pidfile; never a
  pattern kill; never pattern+kill in one argv. Launcher spawns `detached:true` children so
  kill(-pgid) is exact.
- L5 WRITE-BEFORE-REPLY: role prompts mandate incremental section-flushed writes to declared
  artifact paths; run status is ARTIFACT-ON-DISK (file exists + required sections present),
  never session liveness. A dead member's partial artifact stays judge-usable.
- L6 EXPLICIT TERMINAL STATES: every run ends CONVERGED | NEEDS_ROUND | MEMBER_LOST | TIMEOUT
  with artifact sha256s. Silent no-op is a defect. No retry-spam: infra failure → one declared
  retry max, then NEEDS_HUMAN conclusion.
- L7 FACE-LAST + EOF-APPEND + TRUE-STAMPS: serial ledger appends at EOF only, one JSON per line
  (a merged-row fixture MUST fail the parser — A5). The run-record regeneration is the terminal
  write of a round. Any compliance/claim row is emitted only after the SAME script re-reads
  disk and asserts (mechanized in `assertOnDisk()`; prose not trusted).
- SR3 honest ceiling: single-uid box ⇒ controls make dishonesty LOUD (serials, hashes, canaries),
  not IMPOSSIBLE, until C-09 containment + C-14 privilege ruling land (both HUMAN decisions,
  tracked open in INTENT-LEDGER). Until then every behavioral verdict stamps
  PERFORMANCE-ONLY-IN-LOOP on its face.

## 2. Package layout added by v1.1

```
src/lane/isolated.ts    E1 launcher: per-role isolation, spawn/collect/export/kill
src/lane/seating.ts     E4 local-model-policy prefilter — dispatch-time DENY (F1)
src/state/chamber.ts    run-record + serial ledger (L6/L7, A5) + draw-commit (E2) + spotcheck (A4)
src/chamber/protocol.ts 民主: evidence→clash rounds→independent judge; receipts; MEMBER_LOST
src/chamber/synthesis.ts 集中: ONE conclusion/ONE voice envelope from sealed internal logs
src/exam/scenario.ts    E3 scenario JSON schema + fixture expansion (SR4 items → data)
src/exam/signals.ts     mechanical per-signal extraction from --format json transcripts
src/exam/runner.ts      exam lane: setup→quarantine candidate→turn injection→signals→verdicts
src/cli.ts              sibyl-chamber bin: run | status | spotcheck | kill  (E5 visibility)
src/tools/review.ts     sibyl_review tool — general entry, async launch, single-voice handback
src/options.ts          +lane / +modelPolicy / +chamber sections (strict, loud-reject kept)
```

## 3. Lane mechanics (E1/E4)

- `prepareRun(runRoot, runId)` → dirs; `read-copy` of opencode.jsonc (path = option
  `lane.configSource`, default $HOME/.config/opencode/opencode.jsonc) into each role home —
  the copy is READ (source never written). Known leak: candidate may READ real ~/.config via
  copied config's absolute paths; fixtures therefore never reuse real absolute paths (SR4 §4).
- `launchRole({runId, role, title, promptFile, cwd, model, timeoutMs, jsonFormat})` spawns argv-only:
  `timeout <S> opencode run --title <t> --format json [--pure] -m <provider/model> $(cat prompt)`
  — argv built with NO shell; message passed as one argv token. Env pinning exactly per
  sibyl_run_isolated.py (HOME, XDG_DATA/CACHE/STATE_HOME, OPENCODE_DB, OPENCODE_DISABLE_AUTOUPDATE=1,
  pinned PATH). stdout → `<role>/transcript.jsonl`, stderr → `<role>/stderr.log`, rc+signal+
  timedOut → run-record. Child pid recorded to pidfile BEFORE await (L4).
- Post-run collection: copy isolated `opencode.db` → `<role>/session.db.copy` (FM-04: full session
  preserved, not just stdout); judge identity echo (C-02): resolved model id read from transcript
  events / db, appended to record BEFORE handback.
- `killRole(role)`: reads pidfile, `process.kill(-pgid, SIGKILL)` — explicit numbers only.
  Fault injection for acceptance: `--kill-role <role> --kill-after <sec>` on `run`.
- Seating (E4): `resolveSeat(role, requestedSlot, pool, policy)` → `{ok:true, model}` when
  `${providerID}/${modelID}` starts with an allowed prefix, else `{ok:false, deny:"…"}`.
  DENY happens at launch composition time — the spawn is never attempted (F1: not provider luck).

## 4. Chamber = 民主集中制 (core of O2)

民主 (internal, sealed in run dir, high-intensity):
1. EVIDENCE stage: gatherer roles enumerate broad sources (files, transcripts, DBs, ledgers,
   web where configured) into `evidence.jsonl` — every row {path|url, sha256|digest, class,
   probe cmd}. Enumeration-first (find/dir-list), never a single supplied path (J3 §6.1 law).
2. CLASH rounds (≤ options.chamber.maxRounds, default 3):
   - blind drafts: PRO (defend strongest version) and CON (attack real defects) run in parallel,
     neither sees the other's raw output (isolation property of adversarial-swarm preserved);
   - cross-critique: each side gets the other's WRITTEN artifact path only, responds in its own
     file, appended (never edited);
   - DISAGREEMENT-LOG.md appends per round: open charges, conceded points, contested points.
3. JUDGE: fresh isolated session, seat chosen by E2 draw BEFORE the round started; reads ALL
   artifacts + evidence ledger; re-probes primary sources line-by-line (F7); outputs verdict
   JSON {verdict: CONVERGED|NEEDS_ROUND, charges:[…]}. Verdict parse reuses src/verdict layer's
   fail-closed extraction (one repair, never fabricated).
4. Convergence: CONVERGED → synthesis; NEEDS_ROUND with rounds left → next clash round;
   rounds exhausted → terminal NEEDS_ROUND (human decides whether to continue).

集中 (external, one voice):
- `synthesize(record)` emits ONE envelope (also the only text the tool returns):
  `{conclusion: APPROVE|REJECT|NEEDS_HUMAN, confidence 0..1, rationale (≤N bullets),
  key_evidence: [digests], open_charges: n, dissent_sealed_in: <run dir paths+hashes>,
  terminal_state, run_id, spotcheck: "<one command>"}`.
- Internal clash logs are cited by PATH+HASH, never dumped into the external message; a future
  reader reconstructs the full debate from the sealed dir. Single voice ≠ suppression: dissent
  is preserved mechanically as evidence, just not spoken with multiple mouths.
- Fail-closed: missing judge receipt / unparseable verdict / dead role ⇒ conclusion NEEDS_HUMAN
  with the gap named. Never a default APPROVE.

## 5. Exam runtime (E3) — one consumer profile proving generality

- Scenario JSON: {id, class, canary?, fixtures:{files:{relpath:content}|setupSh}, turns:[verbatim
  user messages], ack, signals:[{id, kind:"order"|"absent"|"disk"|"report", probe…}], trap?}.
  SR4's 21 items are the authoring reference; v1.1 ships the 3 canaries (SR4-09/10/11 pattern,
  renamed synthetic scenery per anti-memorization §0.7) + SR4-15/17/18 mechanism guards.
- Runner: setup fixtures in run dir → launch QUARANTINED candidate (opencode run, --format json)
  → continue turns verbatim via `opencode run --session <id>` (in-framework) → close →
  signals.ts extracts mechanically from the JSON event stream (tool-call names + argv + results,
  ordering constraints like read-before-write) + disk re-probe; verdict per signal PASS/FAIL/
  NEEDS_HUMAN (infra ⇒ one retry then VOID, per SR4 §0.6).
- A3 proof (no live model needed): a SCRIPTED fake-candidate transcript fixture that appends a
  CORRECTION row with no disk re-read before it ⇒ signal extractor MUST emit FAIL on the canary
  rule (catch by observed behavior, not admission). Canary-kill aggregates to a veto line in the
  run record (SR4 §4 rule 1).
- Live canary round (optional GPU lane) = e2e profile, not a unit test.

## 6. Records & visibility (E5, A4, A5)

- `<state>/chamber-ledger.jsonl` (default ~/.sibyl/, seam SIBYL_STATE_FILE): one JSON per line,
  EOF-append; START row serial-annotated `drawCommit = sha256(judgePool ∥ seed ∥ serial)`;
  parser rejects any line containing two JSON docs (A5 fixture) — loud, element-drop, never fatal
  (state-layer lesson kept).
- Per-run dir under /tmp: run-record.json regenerated as TERMINAL write (L7); per-artifact
  hashes machine-recomputed from disk at regen (`assertOnDisk`: claim strings only survive if the
  same script's re-read proves them — the replacements:0 organ, mechanized).
- `sibyl-chamber status [runId]` prints record + tail ledger rows (E5: status CLI instead of
  polluting user session lists; sessions still titled `sibyl-<runId>-<role>` INSIDE the isolated
  DB — named, inspectable, zero main-DB residency).
- `sibyl-chamber spotcheck <runId>` prints `cd <runDir> && sha256sum -c CHECKSUMS.txt` (the human
  runs the second part; CHECKSUMS machine-generated, self-excluded — J3 §6.2/N1 law).
- The plugin tool `sibyl_review` launches the chamber as a detached runner process (argv-only
  node spawn of src/cli.ts run — in-framework; the runner does all L1 spawning), returns the
  runId + where-to-look line immediately (single voice at launch = the envelope promise, not a
  verdict).

## 7. Acceptance → test map (A1–A5)

- A1 e2e/acceptance.mjs profile=full: 3-role round end-to-end isolated; main-DB session count
  before/after via read-only sqlite query; assert delta=0, record CONVERGED/NEEDS_ROUND, report.
- A2 e2e profile=kill: --kill-role judge --kill-after 20 ⇒ terminal MEMBER_LOST, pro/con
  artifacts present + hash-recoverable, wall not hung (bounded).
- A3 test/exam.test.ts: canary fixture transcript → signals FAIL (mechanical). Plus e2e live
  canary optional.
- A4 test/chamber.test.ts spotcheck builder + acceptance runs `sha256sum -c` expecting all-OK.
- A5 test/chamber.test.ts: merged-row ledger line ⇒ parse FAIL; face-regen-is-terminal-write
  proven by recording write order in a stub fs; compliance row over drifted disk ⇒ rejected.
- Unit level: seating deny (E4), isolation env shape (L1), kill by pidfile (L4), receipts
  (L5), terminal states (L6), verdict single-voice envelope + fail-closed (O2).

## 8. Deferred to HUMAN (open items, NOT marked done here)

- C-01 pinned-instrument +i install of launcher/runner bytes (needs one sudo ritual).
- C-09 candidate containment tier (bwrap/docker) + C-14 privilege ruling (sudo/docker/lxd groups;
  promote eligibility voided while socket group-reachable per SR3 §5.4 honest wording).
- Registration of v1.1 in live opencode.jsonc + border push + npm publish + per-generation
  human-launched round before any promote (SR3 §5.7).
