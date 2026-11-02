# OPEN-VECTORS — supply-chain vectors, honest status ledger (public face)

Rule (ruling fe01 fix 7): every mitigation that is NOT yet live keeps its
vector recorded as OPEN with a due wheel; the release packet must transcribe
this file's states; nothing here may silently read as "protected".

| # | Vector | Mitigation | Status | Due / evidence |
|---|--------|-----------|--------|----------------|
| V1 | Third-party Action code swaps under a floating version tag (same commit, changed upstream code) | all `uses:` pinned to 40-char commit SHAs; updates only via reviewed dependabot commits | **CLOSED** | v1.6.0 (this wheel); SHAs verified upstream via git ls-remote 2026-11-02 |
| V2 | Dependency install scripts executing during CI (payload class of the malicious-postinstall family) | `npm ci --ignore-scripts` in ci/publish/audit workflows; the floating `npm install -g npm@latest` self-update step REMOVED from publish (blind audit 7a83). HONEST FACE (blind audit 6935): package-lock.json DECLARES install scripts for esbuild 0.28.2 and msgpackr-extract 3.0.4 (optional transitive) — containment is the never-execute posture, NOT script absence; both named here per the no-silent-claims law; one NAMED install: pinned-exact `npm install -g --ignore-scripts npm@11.21.1` in publish (load-bearing for OIDC trusted publishing per the b96369e ENEEDAUTH lesson; npm's own tarball carries no install scripts AND the flag is still passed — belt and braces); no other step runs install scripts | **CLOSED** (containment-by-posture, face-true) | v1.6.0; lock lines cited by 6935 |
| V3 | Advisory published in the build-to-push window (the class that blocked v1.5.0) | weekly scheduled npm audit + pre-publish server-side liveness gate (S1 head-binding, S2 min(1.5x interval, 14d cap constant in gate script)) | **CLOSED for the automated leg** | v1.6.0; residual: window between schedules remains by design — stated, not hidden |
| V4 | Silent removal/neutralization of the gates themselves (workflow edit deleting the audit/liveness steps) | EXTERNAL anchors only: (a) branch protection + required status checks — owner-side setting, seat verifies per wheel via `gh api .../branches/main/protection`; (b) border cross-repo content-hash rule — CR-BORDER-202610 item 6 | **OPEN** | (a) owner action pending, due before next release wheel — until then NO claim of protection; (b) awaiting border department, tracked in CR |
| V5 | Tampered payloads inside already-audited tarballs (what lockfile/manifest scans structurally cannot see) | out of scope for text-level gates; named mechanism if ever needed: provenance/attestation verification at install | **OPEN (accepted, bounded)** | reviewed and accepted by ruling fe01; V2 shrinks the blast radius |

Wheel law: each release packet copies this table verbatim; a CLOSED claim
without its cited receipt demotes the row back to OPEN.
