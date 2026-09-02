# Sibyl-System smoke kit

## Offline smoke (default, deterministic)

No live LLM, no network, no config writes. Proves the shipped surface:
bundle imports → factory disabled-on-bad-options → three `sibyl_*` tools
registered → `sibyl_status` reads an isolated empty store → no residue.

```bash
npm install
npm run build
node smoke/run-smoke.mjs   # exit 0 = SMOKE PASS
```

The script points `SIBYL_STATE_FILE` at a throwaway `sibyl-smoke-*`
sandbox under `os.tmpdir()` (POSIX `/tmp`, `%TEMP%` on Windows) (removed in a `finally` block). Your real `<repo>/.state` and
`~/.sibyl` are never touched: `sibyl_status` is read-only and no run is created.

## Optional live smoke (manual, at your own risk)

End-to-end against a real opencode install. This is **documentation for a
human** — the offline kit above is what CI runs. The proven discipline from
`.omo/evidence/t10` and `.omo/evidence/t11` (`scripts/register-t11.mjs`,
`scripts/unregister-t11.mjs`; internal working evidence, not shipped):

1. **Baseline**: record `sha256sum ~/.config/opencode/opencode.jsonc` (macOS:
   `shasum -a 256`, Windows PowerShell: `Get-FileHash`) and keep
   one backup copy; reuse the same baseline across the whole session.
2. **Register** with jsonc-parser `modify` (preserves comments/formatting),
   write atomically (tmp file + rename), then **re-read the file and assert**
   the sibyl tuple entry `[<abs path>/sibyl-system/src/index.ts, { options: {...} }]`
   is present verbatim and all pre-existing entries are intact.
3. **Prove the plugin loaded before spending a real run**: first
   (`timeout` is GNU-coreutils-only — macOS: `gtimeout`; Windows: omit it or use
   `Start-Process -Wait`) `timeout 540 opencode run --auto "<call sibyl_status and paste the raw output>"`
   — a silent import failure shows up here as a missing tool, not a lost run.
4. **Main call**: one `timeout`-wrapped `opencode run --auto` invoking
   `sibyl_consult` with a *path* argument to a small artifact containing
   planted defects and an explicit "do NOT restate the file inline"
   instruction (learnings: a chatty lead can double the voter sessions).
5. **Restore**: replay-equivalence check, then byte-copy restore; re-assert
   the post sha256 **equals** the baseline sha256.
6. Never signal pre-existing opencode processes; only pids you started, and
   only via your own watchdog.

Keep total live sessions ≤ 2 (smoke + main), as the evidence runs did.
