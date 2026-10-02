// g12b-4/8 probe cores — pure, no network, no git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeRange, consensus, parseCommitMeta, parseHttpDate, probeTimes, type ProbeReceipt } from "../src/tools/probes.ts";

const r = (ownerDept: string, epochMs?: number, ok = true): ProbeReceipt => (epochMs !== undefined ? { url: `https://${ownerDept}`, ownerDept, ok, epochMs } : { url: `https://${ownerDept}`, ownerDept, ok: false, error: "boom" });

test("parseHttpDate: strict", () => {
  assert.equal(typeof parseHttpDate("Wed, 01 Oct 2025 12:00:00 GMT"), "number");
  assert.equal(parseHttpDate(null), undefined);
  assert.equal(parseHttpDate("not-a-date"), undefined);
});

test("consensus needs 2 DISTINCT ownerDepts", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(consensus([r("same", now), r("same", now)], now).verdict, "INSUFFICIENT-SOURCES");
  assert.equal(consensus([r("a", now), r("b", now + 1000)], now).verdict, "SYNCED");
  assert.equal(consensus([r("a", now + 3_600_000), r("b", now + 3_600_000)], now).verdict, "DRIFT");
  assert.equal(consensus([r("a", now, false), r("b", now)], now).verdict, "INSUFFICIENT-SOURCES");
});

test("probeTimes uses injected fetch; unparsable date is a failed receipt", async () => {
  const fakeFetch = (async (url: string) => ({
    headers: new Headers(url.includes("bad") ? {} : { date: "Wed, 01 Oct 2025 12:00:00 GMT" }),
  })) as unknown as typeof fetch;
  const out = await probeTimes([{ url: "https://good", ownerDept: "g" }, { url: "https://bad", ownerDept: "b" }], fakeFetch);
  assert.equal(out[0]!.ok, true);
  assert.equal(out[1]!.error, "no-parseable-date-header");
});

const C = "2".repeat(40);
test("attribution: closed verdicts, byte-exact", () => {
  const commits = parseCommitMeta(`${C}|PublicPersona|pub@example.org|ABCDEF1234567890\n${"1".repeat(40)}|DefaultBot|bot@default.local|`);
  const roster = [{ name: "PublicPersona", email: "pub@example.org", keyFingerprint: "ABCDEF1234567890" }];
  const moves = [
    { remote: "origin", ref: "refs/heads/main", oldSha: null, newSha: C },
    { remote: "origin", ref: "refs/heads/x", oldSha: null, newSha: "1".repeat(40) },
    { remote: "evil", ref: "refs/heads/y", oldSha: null, newSha: "9".repeat(40) },
  ];
  const out = attributeRange(moves, commits, roster);
  assert.equal(out[0]!.verdict, "ATTRIBUTED");
  assert.equal(out[1]!.verdict, "UNATTRIBUTED"); // DefaultBot unbound
  assert.equal(out[2]!.verdict, "UNATTRIBUTED"); // commit absent
});

test("attribution: roster byte-equal duplicates => AMBIGUOUS defect, no pick", () => {
  const commits = parseCommitMeta(`${C}|P|p@e.org|`);
  const roster = [{ name: "P", email: "p@e.org" }, { name: "P", email: "p@e.org" }];
  const out = attributeRange([{ remote: "o", ref: "r", oldSha: null, newSha: C }], commits, roster);
  assert.equal(out[0]!.verdict, "AMBIGUOUS");
});

test("attribution: signed key mismatch is UNATTRIBUTED (bytes-claim w/o signature)", () => {
  const commits = parseCommitMeta(`${C}|P|p@e.org|OTHERKEY999999`);
  const roster = [{ name: "P", email: "p@e.org", keyFingerprint: "ABCDEF1234567890" }];
  const out = attributeRange([{ remote: "o", ref: "r", oldSha: null, newSha: C }], commits, roster);
  assert.equal(out[0]!.verdict, "UNATTRIBUTED");
  assert.match(out[0]!.detail, /signed by key/);
});

test("parseCommitMeta tolerates empty key field (unsigned)", () => {
  const [c] = parseCommitMeta(`${C}|P|p@e.org|`);
  assert.equal(c!.signedByKey, null);
});
