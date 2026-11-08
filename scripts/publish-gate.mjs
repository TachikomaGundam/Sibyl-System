#!/usr/bin/env node
// publish-gate: the pre-publish supply-chain door (v1.6.0 seating, rulings S1/S2).
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
export const DEFAULT_WORKFLOW = "scheduled-audit.yml";
// wait cadence (H1 auto-witness, must-fix 4/6): the bound sits 34x+ above the
// measured wall time of scheduled-audit — last 9 completed runs (2026-11-09,
// gh api run history) took 12s..35s created_at->updated_at including queue.
export const DEFAULTS = { intervalDays: 7, capDays: 14, pollSeconds: 30, waitMinutes: 20 };

export function evaluate(runs, headSha, nowMs, opts) {
  const { intervalDays, capDays } = opts;
  const fail = (why) => ({ verdict: "FAIL", why });
  const branch = opts.defaultBranch ?? "main";
  // 2b4a follow-up: the tripwire is SOME across the whole fetched window, not
  // the newest foreign row only — a poison run deliberately buried behind a
  // failed probe must not slip past the position-based check. Completed-and-
  // failed foreign runs are tolerated (a neutered workflow that died proves
  // nothing); any still-running or green foreign witness run refuses.
  // The tripwire guards BOTH doors: one-shot and release-day wait alike.
  const foreign = runs.filter((r) => (r.event === "schedule" || r.event === "workflow_dispatch") && r.head_branch !== branch);
  const poison = foreign.filter((r) => r.status !== "completed" || r.conclusion === "success");
  if (poison.length > 0) return fail(`witness run(s) on non-default branch(es) [${poison.map((r) => `${r.head_branch}#${r.id}:${r.status}/${r.conclusion}`).join(",")}] — dispatch off-branch is a forgery posture, refusing`);
  if (opts.tagRef !== undefined) return evaluateReleaseDay(runs, headSha, nowMs, opts, fail, branch);
  // repo-owned triggers only; and the witness must come from the DEFAULT
  // BRANCH (6935): dispatch works on any ref, so head_sha alone is forgeable
  // by a write-access actor running a neutered workflow on a side branch whose
  // tip equals the release commit. head_branch=="main" is the branch binding.
  const sched = runs.filter((r) => (r.event === "schedule" || r.event === "workflow_dispatch") && r.head_branch === branch);
  if (sched.length === 0) return fail("no default-branch audit witness has EVER completed (schedule or dispatch) — the door has no history");
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

/** Release-day auto-witness (H1, council-2-alt 2026-11-08, all six must-fixes
 * binding). The witness must be CAUSALLY tied to THIS release, never merely
 * green and nearby: exact head_sha (S1, never "latest green") AND either
 *   (a) event=push whose head_branch is exactly this tag name — the audit the
 *       tag push itself triggered (a lookalike branch named v* is not this
 *       tag: the branch-name equality is the tie), or
 *   (b) a default-branch schedule/dispatch run created at/after the tag ref
 *       came to exist — a stale green on the same sha may not silently pass.
 * Returns PASS / FAIL / WAIT; WAIT only while nowMs < deadlineMs; past the
 * bound the wait itself fails (v1.6.3 died by silence — a timeout is a loud
 * refusal, and the shell escalates it to an owner-visible annotation). */
function evaluateReleaseDay(runs, headSha, nowMs, opts, fail, branch) {
  const createdAfter = opts.tagRefCreatedAtMs ?? 0;
  const overdue = typeof opts.deadlineMs === "number" && nowMs >= opts.deadlineMs;
  const cand = runs.filter(
    (r) =>
      r.head_sha === headSha &&
      ((r.event === "push" && r.head_branch === opts.tagRef) ||
        ((r.event === "schedule" || r.event === "workflow_dispatch") && r.head_branch === branch && Date.parse(r.created_at) >= createdAfter)),
  );
  const done = cand.filter((r) => r.status === "completed");
  const windowMs = Math.min(opts.intervalDays * 1.5, opts.capDays, 14) * 86_400_000;
  if (done.length > 0) {
    const w = done[0]; // API order is newest-first
    if (w.conclusion !== "success")
      return fail(`release-day audit witness ${w.id} (${w.event}/${w.head_branch}) concluded ${w.conclusion} on the release commit — unresolved advisories: fix them or override via a named owner commit; PUBLISH BLOCKED`);
    const ageMs = nowMs - Date.parse(w.created_at);
    if (!(ageMs >= 0) || ageMs > windowMs) return fail(`release-day witness ${w.id} is ${Math.floor(ageMs / 3_600_000)}h old > window ${windowMs / 86_400_000}d — refusing a stale green (S2)`);
    return { verdict: "PASS", why: `release-day audit witness ${w.id} (${w.event}/${w.head_branch}) green on ${String(headSha).slice(0, 12)}, age ${Math.floor(ageMs / 3_600_000)}h` };
  }
  const live = cand.find((r) => r.status !== "completed");
  if (overdue)
    return fail(
      `PUBLISH BLOCKED: publish-gate waited its full bound for a green audit tied to tag ${opts.tagRef} on ${String(headSha).slice(0, 12)} — ${
        live !== undefined ? `witness ${live.id} (${live.event}/${live.head_branch}) never left ${live.status}` : "no tag-tied audit run appeared at all (check scheduled-audit.yml tag trigger and the Actions queue for this tag)"
      }; owner: inspect this repo's Actions runs for ${opts.tagRef} and resolve, then re-run publish`,
    );
  if (live !== undefined) return { verdict: "WAIT", why: `audit witness ${live.id} (${live.event}/${live.head_branch}) is ${live.status} — polling every ${opts.pollSeconds ?? 30}s up to ${opts.waitMinutes ?? 20}min` };
  return { verdict: "WAIT", why: `no audit tied to tag ${opts.tagRef} on ${String(headSha).slice(0, 12)} yet — the tag-triggered audit may still be queued; polling` };
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
  const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
  const num = (v, dflt, name) => {
    if (v === undefined || v === true) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) { console.error(`publish-gate refused: --${name} must be a positive finite number (got ${String(v).slice(0, 20)})`); process.exit(1); }
    return n;
  };
  const intervalDays = num(args["interval-days"], DEFAULTS.intervalDays, "interval-days");
  const capDays = num(args["cap-days"], DEFAULTS.capDays, "cap-days"); // accepted window = min(1.5x interval, capDays, 14d ceiling in evaluator)
  if (!repo || !token || !head) { console.error("publish-gate refused: GH_REPO/GH_TOKEN/HEAD_SHA env required"); process.exit(1); }
  // release-day auto-witness (H1): TAG_REF switches the single S1 check into a
  // bounded wait for an audit tied to THIS tag. Cadence flags are config-visible
  // (defaults above carry the measured wall-time justification, must-fix 4/6).
  const tagRef = process.env["TAG_REF"] ?? "";
  let day = { tagRef: undefined };
  if (tagRef !== "") {
    const createdMs = Date.parse(process.env["TAG_REF_CREATED_AT"] ?? "");
    if (!Number.isFinite(createdMs)) { console.error("publish-gate refused: TAG_REF set but TAG_REF_CREATED_AT is not a parseable timestamp — no causal tie, no publish (fail-closed)"); process.exit(1); }
    day = {
      tagRef,
      tagRefCreatedAtMs: createdMs,
      deadlineMs: Date.now() + num(args["wait-minutes"], DEFAULTS.waitMinutes, "wait-minutes") * 60_000,
      pollSeconds: num(args["poll-seconds"], DEFAULTS.pollSeconds, "poll-seconds"),
      waitMinutes: num(args["wait-minutes"], DEFAULTS.waitMinutes, "wait-minutes"),
    };
  }
  // Pagination (2b4a follow-up): one 10-row page lets an attacker flood the
  // newest rows with failed foreign probes to push the poison row off-screen.
  // Walk up to 5 pages (50 rows) or until a short page; any API error on any
  // page is fail-closed refusal, same as page 1.
  const fetchWindow = async () => {
    const allRuns = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=10&page=${page}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        let hint = "";
        try { const b = await res.json(); hint = ` [github: ${String(b.message).slice(0, 80)}${b.resource ? ` resource=${b.resource}` : ""}]`; } catch { /* body unreadable — status alone still refuses */ }
        console.error(`publish-gate refused: API ${res.status} (page ${page})${hint} (fail-closed — cannot verify, cannot publish)`);
        process.exit(1);
      }
      const body = await res.json();
      const batch = body.workflow_runs ?? [];
      allRuns.push(...batch);
      if (batch.length < 10) break;
    }
    return allRuns;
  };
  for (;;) {
    const r = await fetchWindow().then((allRuns) => evaluate(allRuns, head, Date.now(), { intervalDays, capDays, ...day }));
    if (r.verdict === "WAIT") {
      console.log(`publish-gate: WAIT — ${r.why}`);
      await new Promise((res) => setTimeout(res, (day.pollSeconds ?? DEFAULTS.pollSeconds) * 1000));
      continue;
    }
    console.log(`publish-gate: ${r.verdict} — ${r.why}`);
    // owner-visible failure signal (v1.6.3 died by silence): a workflow
    // annotation, not just a log line lost in a green-looking job shell.
    if (r.verdict === "FAIL" && day.tagRef !== undefined) console.log(`::error::publish-gate: ${r.why}`);
    process.exit(r.verdict === "PASS" ? 0 : 1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("publish-gate.mjs")) main().catch((e) => { console.error(`publish-gate refused: ${e.message}`); process.exit(1); });
