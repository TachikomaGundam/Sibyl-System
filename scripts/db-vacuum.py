#!/usr/bin/env python3
# Sibyl store VACUUM — run ONLY when every opencode instance is closed.
# Refuses to start if any opencode process is alive (no busy-error fireworks on
# live writers — the failure class this whole procedure exists to avoid).
# Prints before/after sizes + row counts + integrity check; receipts land in
# the Sibyl evidence dir.
import os, sqlite3, subprocess, sys, time, json, datetime

DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
RECEIPT = os.path.expanduser("~/workspace/harness/Sibyl/.omo/evidence/vacuum-%s.json" % datetime.date.today().isoformat())

def die(msg):
    print(f"REFUSED: {msg}"); sys.exit(1)

alive = subprocess.run(["pgrep", "-f", "opencode$"], capture_output=True, text=True).stdout.split()
if alive:
    die(f"opencode instances still running (pids {alive[:4]}...) — close them all first (TUI and serve); this tool will not fight live writers")
if not os.path.exists(DB):
    die(f"{DB} not found")

before = os.path.getsize(DB)
con = sqlite3.connect(DB)
try:
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("session", "message", "part")}
    t0 = time.time()
    con.isolation_level = None
    print(f"vacuuming {before/1e9:.2f}G, store may take several minutes to rebuild...")
    con.execute("VACUUM")
    dur = time.time() - t0
    after = os.path.getsize(DB)
    ok = con.execute("PRAGMA integrity_check").fetchone()[0]
    counts_after = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("session", "message", "part")}
finally:
    con.close()

rec = {"db": DB, "before_bytes": before, "after_bytes": after, "seconds": round(dur), "integrity": ok, "rows_before": counts, "rows_after": counts_after}
json.dump(rec, open(RECEIPT, "w"), indent=1)
print(json.dumps(rec, indent=1))
print("OK" if ok == "ok" and counts == counts_after else "CHECK RECEIPT MANUALLY")
