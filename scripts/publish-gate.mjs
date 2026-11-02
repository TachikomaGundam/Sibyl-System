#!/usr/bin/env node
// publish-gate: the pre-publish supply-chain door (v1.60 seating, rulings S1/S2).
//
// FAILS the publish unless the LATEST scheduled audit workflow run is
//   (a) completed SUCCESSFUL,
//   (b) bound to the exact commit being released (S1: head_sha == HEAD —
//       a re-run of an old green commit must not vouch for new code),
//   (c) fresh: younger than min(1.5 x cron interval, ABSOLUTE cap) (S2: the
//       cap is a constant in THIS file, so widening the cron cannot widen
//       the accepted window past the cap).
// All judgment is a pure function (unit-locked); the network shell only
// fetches the run list from the GitHub API.
//
// Usage (CI): node scripts/publish-gate.mjs --workflow scheduled-audit.yml
//   env: GH_REPO=owner/name, GH_TOKEN=${{ secrets.GITHUB_TOKEN }}, HEAD_SHA from context

/** Pure evaluator — unit-tested in test/publish-gate.test.ts. */
export function evaluate(runs, headSha, nowMs, opts) {
  const { intervalDays, capDays } = opts;
  const fail = (why) => ({ verdict: "FAIL", why });
  // repo-owned triggers only; and the witness must come from the DEFAULT
  // BRANCH (6935): dispatch works on any ref, so head_sha alone is forgeable
  // by a write-access actor running a neutered workflow on a side branch whose
  // tip equals the release commit. head_branch=="main" is the branch binding.
  const sched = runs.filter((r) => (r.event === "schedule" || r.event === "workflow_dispatch") && r.head_branch === (opts.defaultBranch ?? "main"));
  if (sched.length === 0) return fail("no default-branch audit witness has EVER completed (schedule or dispatch) — the door has no history");
  const foreign = runs.filter((r) => (r.event === "schedule" || r.event === "workflow_dispatch") && r.head_branch !== (opts.defaultBranch ?? "main"));
  if (foreign.length > 0 && (foreign[0].status !== "completed" || foreign[0].conclusion === "success")) return fail(`witness run(s) on non-default branch(es) [${foreign.map((r) => r.head_branch).join(",")}] exist — dispatch off-branch is a forgery posture, refusing`);
  const latest = sched[0]; // API returns newest first
  if (latest.status !== "completed") return fail(`latest scheduled run ${latest.id} status=${latest.status} (not completed) — waiting is capped, a hung audit blocks publish by design`);
  if (latest.conclusion !== "success") return fail(`latest scheduled run ${latest.id} conclusion=${latest.conclusion} — a red audit means unresolved advisories: fix or override via a named owner commit, never by shipping past it`);
  if (latest.head_sha !== headSha) return fail(`latest green audit ran on ${String(latest.head_sha).slice(0, 12)}, release HEAD is ${String(headSha).slice(0, 12)} (S1: main moved un-audited — wait for the next schedule or trigger one)`);
  const ageMs = nowMs - Date.parse(latest.created_at);
  const CAP_CEILING_DAYS = 14; // S2 absolute ceiling: args can only NARROW it
  const windowMs = Math.min(intervalDays * 1.5, capDays, CAP_CEILING_DAYS) * 86_400_000;
  if (!(ageMs >= 0) || ageMs > windowMs) return fail(`latest green audit is ${Math.floor(ageMs / 3_600_000)}h old > window ${windowMs / 86_400_000}d (S2: min(1.5x cron ${intervalDays}d, cap ${capDays}d, ceiling ${CAP_CEILING_DAYS}d))`);
  return { verdict: "PASS", why: `latest scheduled audit run ${latest.id} green on ${String(latest.head_sha).slice(0, 12)} age ${Math.floor(ageMs / 3_600_000)}h` };
}

const args = (() => {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const eq = /^--([^=]+)=(.*)$/.exec(argv[i]);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    const bare = /^--([^=]+)$/.exec(argv[i]);
    if (!bare) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[bare[1]] = next; i += 1; }
    else out[bare[1]] = true;
  }
  return out;
})();

async function main() {
  const repo = process.env["GH_REPO"] ?? "";
  const token = process.env["GH_TOKEN"] ?? "";
  const head = process.env["HEAD_SHA"] ?? "";
  const workflow = String(args.workflow ?? "scheduled-audit.yml");
  const intervalDays = Number(args["interval-days"] ?? 7);
  const capDays = Number(args["cap-days"] ?? 14); // accepted window = min(1.5x interval, capDays, 14d ceiling in evaluator)
  if (!repo || !token || !head) { console.error("publish-gate refused: GH_REPO/GH_TOKEN/HEAD_SHA env required"); process.exit(1); }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=10`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    let hint = "";
    try { const b = await res.json(); hint = ` [github: ${String(b.message).slice(0, 80)}${b.resource ? ` resource=${b.resource}` : ""}]`; } catch { /* body unreadable — status alone still refuses */ }
    console.error(`publish-gate refused: API ${res.status}${hint} (fail-closed — cannot verify, cannot publish)`);
    process.exit(1);
  }
  const body = await res.json();
  const r = evaluate(body.workflow_runs ?? [], head, Date.now(), { intervalDays, capDays });
  console.log(`publish-gate: ${r.verdict} — ${r.why}`);
  process.exit(r.verdict === "PASS" ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("publish-gate.mjs")) main().catch((e) => { console.error(`publish-gate refused: ${e.message}`); process.exit(1); });
