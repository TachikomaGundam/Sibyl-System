# Changelog

All notable changes to Sibyl-System are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Authoritative per-release detail lives in the release packets under `docs/release/` (this file summarizes; the packets and the tag anchors are the single source).

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
