# Changelog

All notable changes to Sibyl-System are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Authoritative per-release detail lives in the release packets under `docs/release/` (this file summarizes; the packets and the tag anchors are the single source).

## [Unreleased] — v2.0.0 target (opencode 2.x migration)

### Changed
- **opencode 2.x plugin platform.** The plugin is now the V2 entry shape
  (`{ id, setup(ctx) }`, tools via `ctx.tool.transform`, options via the V2
  `plugins` config object form). The V1 `@opencode-ai/plugin` dependency is
  gone; the bundle contains zero `@opencode` runtime imports. V1 registrations
  stop loading under opencode 2.x — rewire per README (opencode 1.x is
  retired). Engine business logic is unchanged: the same
  `EngineClient` seam is bridged by `src/v2/adapter.ts`
  (create→`session.create` with `location.directory`, model per prompt via
  `switchModel`, completion via `wait` + `context`, persona system via the
  `context` hook). See `docs/V2-MIGRATION.md`.
- **Voter tool-gate enforcement point.** Disallowed voter/worker tools are
  refused at execution time (`ctx.tool.hook("execute.before")`) instead of
  being hidden from the per-prompt tool list — same law, stricter point.
- **Session retention tool.** `scripts/session-reap.mjs` enumerates the 2.x
  `session_v2` store and deletes through `opencode session delete <id>`
  (engine-owned cascade); the old `serve` + `DELETE /session/:id` channel is
  answered 405 by 2.x. Classifier and retention law unchanged.

### Fixed
- **Engine-default model parity.** An empty `modelPool` default now skips
  `switchModel` entirely (V1 parity); under 2.x a literal empty model ref
  persisted to an unusable route and killed every voter
  (`provider.no-route`).
- **Idle-failure visibility.** A session that reaches idle with no assistant
  message now reports the engine's idle outcome and provider error instead of
  a bare "no assistant message".

### Added
- `scripts/workdoc-guard.mjs` denylist extended with scratch/cache/editor-junk
  classes (logs, `.bak/.orig/.rej/.swp/.tmp`, notebooks, interpreter caches,
  device metadata, IDE workspace dirs) — owner hygiene directive 2026-11-12.

## [1.6.4] - 2026-11-08

### Fixed
- **Portable role containment.** Non-Linux role launches now require the credential
  relay instead of inheriting host provider credentials; Windows role homes use
  Windows profile variables and timeout termination targets the child process.
- **Release documentation.** The README now documents the chamber-ledger override,
  correct proxy origins and endpoint set, portable containment, complete CLI examples,
  and npm-safe source links.

## [1.6.3] - 2026-11-07

### Added
- **Credential proxy for isolated roles.** An optional loopback relay now keeps
  upstream provider credentials in the trusted runner. Roles receive scoped,
  quota-limited tokens and a synthesized provider-only config; their host
  OpenCode config and environment credentials no longer cross the isolation
  boundary when `credentialProxy` is enabled.

### Fixed
- **Isolated role containment.** Required chamber sandboxes now use separate
  namespaces and a minimal environment; agent-controlled shell and web tools
  are denied. Failed Swarm draft writes cannot produce an approval, repeated
  CLI `--scenario` options retain every path, and invalid launch inputs no
  longer leave stale run directories.

### Changed
- README now documents credential-proxy configuration, migration, and the
  remaining local-account and unsandboxed-venue boundary.

## [1.6.2] - 2026-11-05

### Fixed
- **Chamber runs can no longer die without a record** (wound
  2026-11-04 dead-without-record, run
  sibyl-20261102T133505Z-4393): the review tool now captures the detached
  runner's stdout/stderr into `startup.log` inside the run dir; the CLI entry
  carries a fatal boundary writing `startup-error.json` on any uncaught
  fault; and `status --run-id` names `DEAD-WITHOUT-RECORD` when the ledger is
  silent while the run dir holds only the launcher's staged files — instead
  of the old indistinguishable "no chamber runs recorded". `SIBYL_CHAMBER_LEDGER`
  isolates the ledger the way `SIBYL_STATE_FILE` isolates the runs store.
  No fail-closed property changed; release (version/tag/publish) stays a
  human gate.
- **Chamber role timeout no longer sits below the measured heavy-role band** (wound
  2026-11-04 role-timeout-below-measured, runs sibyl-20261104T094318Z-2421 /
  -094434Z-42db / -094437Z-0a9c / -100648Z-8ed1): `lane.roleTimeoutMs` defaulted to 600s
  while the engine documents heavy ballots finishing 500-700s under load, so one legitimate
  heavy role call timed the whole session out before the judge entered. New named default
  `DEFAULT_ROLE_TIMEOUT_MS = 1_200_000` (single source; the CLI fallback references it instead
  of repeating the old literal) plus a SALVAGE grace (`DEFAULT_ROLE_SALVAGE_GRACE_MS =
  900_000`): at deadline the lane no longer SIGKILLs but waits for the role to finish; work
  completing inside grace is kept and disclosed on the ledger face (`salvagedMs`), grace
  exhausted still SIGKILLs with timedOut=true. TIMEOUT semantics and quorum untouched -
  fail-closed unchanged; calibration + salvage only.

## [1.6.1] - 2026-11-03

### Added
- **Server-side tag paperwork** (`scripts/tag-paperwork.mjs`, new workflow step
  in publish): tag name must equal `package.json`'s version and
  `docs/release/<version>.md` must carry a literal `gate: PASS` line — the
  receipt/parity law now re-runs server-side, where `--no-verify` cannot
  reach (blind-audit 98f3 blocker; 8 lock tests).

### Fixed
- **Publish-gate tripwire is now window-wide**: a poison witness on a foreign
  branch buried behind failed probes no longer slips past the position-based
  check — refusal is a SOME over the fetched window, the CLI shell paginates
  5x10, and any API error mid-pagination is fail-closed like page one.
  Completed-and-failed foreign probes stay tolerated (they prove nothing).

### Changed
- **README rewritten for outside readers** (third-party review, grade C+):
  a why-three-voters opener; internal rule codes demoted to parentheticals
  defined at first use; institutional jargon replaced with plain language;
  all version-history markers moved out of the body into this file.
- **Corrected a documented falsehood**: the README previously claimed an
  unparseable councilor reply becomes a 0-confidence REJECT ballot. The code
  makes it an ERROR seat: not tallied, blocks approval, can force
  CANNOT_ANSWER (`src/tools/consult.ts`). The fail-closed policy section now
  states the real judgment table.

## [1.6.0] - 2026-11-02

### Added
- **Supply-chain seating** (owner-ratified council ruling fe01): weekly scheduled
  `npm audit` workflow; pre-publish **server-side liveness gate** — publish fails
  unless the latest scheduled audit run is green, bound to the exact released
  commit (S1), and younger than min(1.5x interval, 14-day cap held in the gate
  script, not the mutable cron) (S2).
- **Actions SHA-pinned** to upstream commit SHAs (verified via git ls-remote);
  floating-tag code swaps now require a reviewed commit to happen.
- **`npm ci --ignore-scripts`** as standing CI posture — verified full doors green
  script-free (esbuild 0.28.2 needs no install scripts): zero exemptions in force;
  any future one must be named in OPEN-VECTORS.md.
- **OPEN-VECTORS.md**: honest public ledger — every mitigation not yet live keeps
  its vector OPEN with a due wheel; release packets must transcribe it.
- **`npm run reap`**: bounded session retention (the L1 law only reclaimed headless
  children; parented ones accumulated forever — measured 1573, root cause of the
  2026-11 machine slowdown). Dry-run default, JSONL decision manifest, deletions
  only via the engine's own API; audit conveners retained >= 90 days per owner
  ruling with the reconciliation face preserved in the sealed manifest.

### Changed
- Audit receipt states the 90-day retention horizon (ruler face unchanged).
- `scripts/db-vacuum.py` armed with a live-writer refusal guard, after a
  full-scale rehearsal measured 9.33G->9.28G in 679s — recorded: the store is
  real data, not free-page bloat; in-place VACUUM is not worth a window.

### Evidence
Suite 485 -> 493 (publish-gate S1/S2 semantics unit-locked 8 cases; reap
classifier 5 cases). Open vectors V1/V2/V3 CLOSED with receipts; V4 (gate
self-deletion anchors: branch protection = owner action due before next release;
border cross-rule = CR-BORDER-202610 item 6) and V5 (tarball payloads, accepted
bounded) recorded OPEN — no silent protection claims.

## [1.5.1] - 2026-10-28

### Fixed
- **Security chain (GHSA-mrhx-c7xc-m3w5).** zod `<4.6.6` (high: memory exhaustion on
  oversized constrained collections) was published into both dependency chains — the
  direct `zod` and the nested `zod` under `@opencode-ai/plugin` — *between* the v1.5.0
  wheel build (audit green that day) and its push days later. The standing
  `npm audit --audit-level=high` door (introduced v1.4.0) failed the publish job and
  the tag-push CI: **nothing of 1.5.0 was ever served** — registry still had no 1.5.0
  at gate time (verified by receipt, see 1.5.0 note). Fix follows the v1.4.0 toml
  precedent: direct `zod` to `^4.6.7`, nested plugin zod forced by scoped `overrides`
  (the plugin's own fix range offers only a breaking downgrade). Offline suite,
  build, smoke, coverage green on the override; `npm audit` clean.

## [1.5.0] - 2026-10-24 — tag minted 2026-10-24, pushed 2026-10-28; NEVER PUBLISHED

The annotated tag `v1.5.0` exists (audited release face), but its publish workflow was
**blocked by the audit door** when the zod advisory landed in the interim window. The
semver face below shipped in 1.5.1 (identical content plus the zod fix); the tag is
honestly kept in place — no history rewrite.

### Added
- **SSRF egress gate on `sibyl_time_probe`** (`classifyEgress`): caller URLs are refused by rule name before any fetch — non-http(s) schemes, userinfo, non-default ports, IPv4/IPv6 reserved families (loopback, private, link-local incl. cloud-metadata `169.254.0.0/16`, CGNAT, multicast/reserved, ULA, and mapped/compat/6to4 addresses whose embedded IPv4 is re-checked), single-label hosts and internal name suffixes. Blocked sources become `blocked-egress` failed receipts — blocked is never consent; all-blocked yields `INSUFFICIENT-SOURCES` with zero fetches.
- **Input-shape validation on both probes**: `endpoints`, `moves`, `roster` pass bounded-array JSON parsing + per-entry shape validators; malformed input is a named `INPUT REJECTED` (field-pathed, entry-indexed), never an internal error and never a guessed-at consumption.
- **Tag-body hygiene gate** in the release hook: pushed annotated-tag message bodies refuse home-path shapes and email shapes by rule name (root cause: the v1.4.0 tag message carried one machine-local clone path onto the public remote; the class now has a ruler — that tag is honestly kept, history unrewritten).
- Community surface: `SECURITY.md` (disclosure channel + data-egress map + named limitations), this changelog, Dependabot (npm + GitHub Actions, weekly).
- Offline coverage floor as a standing npm `coverage` script (ratchet: the floor only moves up).

### Changed
- `withTimeout`, the unknown-error renderer, and `DEFAULT_TIMEOUT_MS` collapsed to single definitions (`src/util.ts`, `src/options.ts`) — previously two and three silent copies with drift risk; behavior unchanged.
- Engine `session.delete`/`get` seams now carry `query.directory` like their siblings; both `as never` casts in the SDK adapter are gone (the casts had been masking the host's instance-scoped call contract from the type-checker).

### Known limitations (named, not papered over)
- The SSRF gate judges URL **literal** shapes. A public hostname whose DNS answer resolves into internal space is not filtered: the fetch API cannot pin a connection to a pre-verified IP (TOCTOU). Mitigations in force: HEAD method, zero payload, redirects not followed. Details in `SECURITY.md`.

## [1.4.0] - 2026-10-23

- Security-chain cleanup: `@opencode-ai/plugin` 1.15.13 → 1.19.4, `overrides` pin `toml@5.0.1` (three quadratic/DoS advisories zeroed), `npm audit --audit-level=high` as a standing CI step.
- Private run dirs: every plugin-created directory is mode 0700 regardless of umask.
- Refused-launch law: explicit `--run-id` with a missing/malformed staged `launch-context.json` is refused **with a record** (`launch-refusal.json`); bare CLI keeps its named `UNVERIFIABLE` leg; the regenerated run record outvouches contradicted staged claims ("record wins").
- CI doors: push/PR workflow mirroring `ship.sh` + audit; publish job on the full doors; `engines: node >= 22`.
- See `docs/release/v1.4.0.md`.

## [1.3.6] - 2026-10-15

- Evidence-law wheel for the W1-v2 lineage detector (identical-template-row inflation and cross-checkout windows found by adversarial ballots on the 1.3.5 campaign). See `docs/release/v1.3.6.md`.

## [1.3.5] - 2026-10-14

- Ruler-repair wheel: lineage-detector calibration fixes shipped with the calibration probe. See `docs/release/v1.3.5.md`.

## [1.3.4] - 2026-10-14

- W1 third leg: the chamber review lane can no longer record silence where independence was never checked; sanctioned one-shot transport retry for transport-class seat deaths. See `docs/release/v1.3.4.md`.

## [1.3.3] - 2026-10-10

- `sibyl_audit`: the outside independent-audit lane becomes a product organ. See `docs/release/v1.3.3.md`.

## [1.3.2] - 2026-10-08

- W1-v2 content-lineage leg for convener recusal (drafting evidence across checkouts). See `docs/release/v1.3.2.md`.

## [1.3.1] - 2026-10-06

- History-correction wheel (see the superseding correction section in `docs/release/v1.3.1.md` — read its body claims through that section).

## [1.3.0] - 2026-10-05

- Ballot-integrity laws W1–W4: convener recusal, absence-as-disability terminal rows, instrument face (`rules=`) on every ballot, tag-object-only release facts; W1 historical backfill; live-fire e2e proofs. See `docs/release/v1.3.0.md`.

## Earlier (pre-packet era)

- 1.2.x — fail-closed `CANNOT_ANSWER` semantics for wounded-instrument tallies (pinned by `test/council.test.ts`).
- 1.1.x — review chamber (`sibyl_review` / `sibyl-chamber`): isolated evidence → blind clash → drawn judge, one voice.
- 1.0.x — original clean-room release: three-voter `sibyl_consult`, `sibyl_swarm`, run store.
