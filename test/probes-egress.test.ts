// v1.5.0 input law + SSRF gate (queue §3.1): classifyEgress is pure and offline;
// the execute bodies are tested through the auditExecute-style seams with fetch
// injected — no network, ever. The gate judges URL LITERAL shapes only; the
// named hostname-DNS limitation lives in SECURITY.md, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyEgress,
  parseJsonArray,
  validateMoves,
  validateRoster,
  validateTimeSources,
  timeProbeExecute,
  type EgressVerdict,
  attributeExecute,
  MAX_INPUT_ITEMS,
} from "../src/tools/probes.ts";

const reasonOf = (v: EgressVerdict): string => (v.ok ? "ok" : v.reason);

test("classifyEgress: public https/http hosts pass", () => {
  assert.deepEqual(classifyEgress("https://www.cloudflare.com"), { ok: true, host: "www.cloudflare.com" });
  assert.equal(classifyEgress("http://time.example.org/").ok, true);
  assert.equal(classifyEgress("https://203.0.113.42").ok, false); // doc-test range is refused too
  assert.equal(classifyEgress("https://8.8.8.8").ok, true);
});

test("classifyEgress: scheme/userinfo/port closed", () => {
  assert.match(reasonOf(classifyEgress("file:///etc/passwd")), /scheme-file-forbidden/);
  assert.match(reasonOf(classifyEgress("ftp://time.example")), /scheme-ftp-forbidden/);
  assert.match(reasonOf(classifyEgress("https://user:pw@example.com")), /userinfo-forbidden/);
  assert.match(reasonOf(classifyEgress("https://example.com:8443")), /port-8443-forbidden/);
  assert.equal(classifyEgress("https://example.com:443").ok, true); // default port normalizes away
  assert.equal(classifyEgress("not a url at all").ok, false);
});

test("classifyEgress: IPv4 reserved families refused by rule name", () => {
  const blocked: [string, string][] = [
    ["http://127.0.0.1/", "loopback-127/8"],
    ["http://10.1.2.3/", "private-10/8"],
    ["http://172.16.0.1/", "private-172.16/12"],
    ["http://192.168.1.1/", "private-192.168/16"],
    ["http://169.254.169.254/latest/meta-data/", "linklocal-169.254/16"],
    ["http://100.64.0.1/", "cgnat-100.64/10"],
    ["http://0.0.0.0/", "this-network-0/8"],
    ["http://224.0.0.1/", "multicast-224/4"],
    ["http://240.0.0.1/", "reserved-240/4"],
    ["http://198.18.0.1/", "benchmark-198.18/15"],
  ];
  for (const [url, rule] of blocked) {
    const v = classifyEgress(url);
    assert.equal(v.ok, false, url);
    assert.ok((v as { ok: false; reason: string }).reason.includes(rule), `${url} -> ${String(v)}`);
  }
});

test("classifyEgress: encoded IPv4 forms normalize then fall to the same rules", () => {
  // WHATWG URL normalizes decimal/hex IPv4 to dotted-quad before we look
  assert.equal(classifyEgress("http://2130706433/").ok, false); // 127.0.0.1 decimal
  assert.match(reasonOf(classifyEgress("http://0x7f000001/")), /loopback-127\/8/);
});

test("classifyEgress: IPv6 families refused", () => {
  assert.match(reasonOf(classifyEgress("http://[::1]/")), /v6-loopback/);
  assert.match(reasonOf(classifyEgress("http://[::]/")), /v6-unspecified/);
  assert.match(reasonOf(classifyEgress("http://[fd12:3456::1]/")), /v6-ula-fc00::\/7/);
  assert.match(reasonOf(classifyEgress("http://[fe80::1]/")), /v6-linklocal-fe80::\/10/);
  assert.match(reasonOf(classifyEgress("http://[ff02::1]/")), /v6-multicast-ff00::\/12/);
  assert.match(reasonOf(classifyEgress("http://[::ffff:127.0.0.1]/")), /v6-mapped-loopback-127\/8/);
  assert.match(reasonOf(classifyEgress("http://[2002:0a00:0001::1]/")), /6to4/); // 2002:: embeds 10.0.0.1
  assert.equal(classifyEgress("https://[2606:4700:4700::1111]/").ok, true); // cloudflare v6 passes
});

test("classifyEgress: single-label and internal-suffix names refused", () => {
  assert.match(reasonOf(classifyEgress("http://metadata/")), /single-label-host/);
  assert.match(reasonOf(classifyEgress("http://localhost/")), /loopback-localhost/);
  assert.match(reasonOf(classifyEgress("http://nas.home.lan/")), /internal-suffix\.lan/);
  assert.match(reasonOf(classifyEgress("https://time.corp.internal/")), /internal-suffix\.internal/);
  assert.match(reasonOf(classifyEgress("https://api.localhost/")), /internal-suffix\.localhost/);
});

test("parseJsonArray: named rejections, caps enforced", () => {
  assert.equal(parseJsonArray("nope", "moves", 10).ok, false);
  assert.match(String((parseJsonArray("nope", "moves", 10) as { ok: false; error: string }).error), /moves: not valid JSON/);
  assert.match(String((parseJsonArray('{"a":1}', "roster", 10) as { ok: false; error: string }).error), /roster: expected a JSON array/);
  const big = JSON.stringify(Array.from({ length: MAX_INPUT_ITEMS + 1 }, () => ({})));
  assert.match(String((parseJsonArray(big, "moves", MAX_INPUT_ITEMS) as { ok: false; error: string }).error), /exceeds the .* cap/);
});

test("validators: shape refused with entry index", () => {
  assert.equal(validateTimeSources([{ url: "https://a", ownerDept: "a" }]).ok, true);
  const bad = validateTimeSources([{ url: "https://a", ownerDept: "a" }, { url: 3 }]) as { ok: false; error: string };
  assert.equal(bad.ok, false);
  assert.match(bad.error, /entry #1/);
  assert.equal(validateMoves([{ remote: "o", ref: "r", oldSha: null, newSha: "f".repeat(40) }]).ok, true);
  assert.equal(validateMoves([{ remote: "o", ref: "r", newSha: 5 }]).ok, false);
  assert.equal(validateRoster([{ name: "n", email: "e" }]).ok, true);
  assert.equal(validateRoster([{ name: "n", email: "e", keyFingerprint: 7 }]).ok, false);
});

const dateHeaders = { headers: new Headers({ date: "Wed, 01 Oct 2025 12:00:00 GMT" }) };
const fakeOkFetch = (async () => dateHeaders) as unknown as typeof fetch;

test("timeProbeExecute: malformed endpoints is a named INPUT REJECTION, not internal error", async () => {
  const out = await timeProbeExecute({ endpoints: "{oops" }, { fetchImpl: fakeOkFetch });
  assert.match(out, /sibyl_time_probe INPUT REJECTED: endpoints: not valid JSON/);
});

test("timeProbeExecute: private endpoints blocked, never fetched; verdict stays fail-closed", async () => {
  let fetched = 0;
  const countingFetch = (async () => {
    fetched += 1;
    return dateHeaders;
  }) as unknown as typeof fetch;
  const endpoints = JSON.stringify([
    { url: "http://169.254.169.254/latest/meta-data", ownerDept: "aws-meta" },
    { url: "https://one.example", ownerDept: "one" },
    { url: "https://two.example", ownerDept: "two" },
  ]);
  const out = await timeProbeExecute({ endpoints }, { fetchImpl: countingFetch });
  assert.match(out, /fail http:\/\/169\.254\.169\.254\/latest\/meta-data \(aws-meta\) — blocked-egress:linklocal-169\.254\/16/);
  assert.match(out, /SIBYL TIME SYNCED|DRIFT/); // the two allowed sources still certify
  assert.equal(fetched, 2);
});

test("timeProbeExecute: ALL endpoints blocked = INSUFFICIENT-SOURCES, zero fetches", async () => {
  let fetched = 0;
  const spy = (async () => {
    fetched += 1;
    return dateHeaders;
  }) as unknown as typeof fetch;
  const endpoints = JSON.stringify([
    { url: "http://127.0.0.1:8080/", ownerDept: "x" },
    { url: "http://localhost/", ownerDept: "y" },
  ]);
  const out = await timeProbeExecute({ endpoints }, { fetchImpl: spy });
  assert.match(out, /SIBYL TIME INSUFFICIENT-SOURCES/);
  assert.match(out, /blocked-egress/);
  assert.equal(fetched, 0);
});

test("attributeExecute: mis-shaped moves/roster refused by name before any comparison", () => {
  assert.match(attributeExecute({ moves: "[]", commits: "", roster: "{}" }), /INPUT REJECTED: roster: expected a JSON array/);
  assert.match(
    attributeExecute({ moves: JSON.stringify([{ remote: "o", ref: "r" }]), commits: "", roster: "[]" }),
    /INPUT REJECTED: moves entry #0: field "newSha"/,
  );
  const out = attributeExecute({
    moves: JSON.stringify([{ remote: "o", ref: "r", oldSha: null, newSha: "a".repeat(40) }]),
    commits: `${"a".repeat(40)}|P|p@e.org|`,
    roster: JSON.stringify([{ name: "P", email: "p@e.org" }]),
  });
  assert.match(out, /ALL ATTRIBUTED/);
});
