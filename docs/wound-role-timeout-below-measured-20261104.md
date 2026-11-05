# Wound: chamber role timeout default sat below measured role duration (2026-11-04)

## Symptom
Three review chambers (runs sibyl-20261104T094318Z-2421, sibyl-20261104T094434Z-42db,
sibyl-20261104T094437Z-0a9c) and one serial retry (sibyl-20261104T100648Z-8ed1) all ended
terminal=TIMEOUT with the judge never entered. Live observation 2421: serial=33, 1/4 rounds
done, killed at ~16.5 min; the death timing matches a role hitting the 600s lane budget
(protocol.ts #terminalFor: one timedOut receipt -> whole run TIMEOUT, by design fail-closed).

## Root cause
lane.roleTimeoutMs defaulted to 600_000 - below the engine's own measured heavy-ballot band
(500-700s under shared-GPU load, SALVAGE comment in src/engine/index.ts). Under any contention
a legitimate heavy role call predictably exceeds 600s, so review sessions with maxRounds>=3
could not complete: the budget was structurally incompatible with the declared work.

## Fix (two parts, one wound)
1. Calibration: DEFAULT_ROLE_TIMEOUT_MS = 1_200_000 (single source; cli.ts fallback references
   the constant). Run ...100648Z-8ed1 and ...094318Z-2421 showed 600s sits inside the measured
   band; the serial verify run ...104227Z-a19e then proved even 1200s is exceeded by heavy
   cross-critique calls under contention - a FIXED budget cannot bound this work.
2. SALVAGE grace (engine precedent, src/engine/index.ts): DEFAULT_ROLE_SALVAGE_GRACE_MS =
   900_000. At deadline the lane no longer SIGKILLs; it marks the role overdue and waits the
   grace for natural completion. Work that provably completes (exit rc0) is KEPT and
   DISCLOSED (LaunchOutcome.salvagedMs -> LaunchFacts.salvagedMs -> ledger gap line
   "SALVAGED - completed Xms past its deadline"). Grace exhausted: SIGKILL + timedOut=true,
   exactly as before. Timeout semantics, quorum and fail-closed unchanged.

## Prevention
The named constant + comment names the measured band, so future budget edits must re-read
this wound. Test asserts the new default (test/options.test.ts).

## Chain
Reported by the PCB seat via owner order "修后裁" (repair, then re-adjudicate); repair is a
calibration to already-documented machine measurements, no policy change.
