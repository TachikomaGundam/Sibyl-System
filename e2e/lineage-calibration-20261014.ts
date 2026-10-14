// lineage-threshold calibration probe (ruler-health procedure, 2026-10-14)
// Nine cases spanning true-drafting, template cross-contamination, read-back,
// time-gated copies and the 60% boundary — measures the RULER, not a candidate.
import { assessIndependence } from "../src/independence.ts";
import { readFileSync } from "node:fs";

type Row = { info?: Record<string, unknown>; parts?: Record<string, unknown>[] };
const mk = (sessions: Map<string, { parentID?: string; messages?: Row[] }>) => ({
  session: {
    async create() { return { data: { id: "unused" } }; },
    async prompt() { return { data: { info: {}, parts: [] } }; },
    async get(a: { path: { id: string } }) {
      const s = sessions.get(a.path.id);
      return s ? { data: { id: a.path.id, parentID: s.parentID ?? "" } } : { error: { message: "x" } };
    },
    async messages(a: { path: { id: string } }) {
      const s = sessions.get(a.path.id);
      return s ? { data: s.messages ?? [] } : { error: { message: "x" } };
    },
  },
}) as never;

const tool = (t: string, input: Record<string, unknown>, time = 1000): Row =>
  ({ info: { role: "assistant", time: { created: time } }, parts: [{ type: "tool", tool: t, input }] });

const A = readFileSync("docs/release/v1.3.1.md", "utf8"); // ~12KB real packet
const B = readFileSync("docs/release/v1.3.0.md", "utf8"); // sibling template-era packet
const MT = Math.floor(Date.now() / 1000); // artifact mtime ~ now
const art = (text: string) => ({ ok: true as const, kind: "path" as const, source: "/work/target.md", text, mtimeMs: MT });

const cases: [string, Row[], string, boolean][] = [ /* law: majority-of-bytes OR full containment convicts; minority drafting reads independent BY DESIGN */
  ["C1 full write, other path, before mtime (526d class)", [tool("write", { filePath: "/tmp/clone/target.md", content: A })], "drafting", true],
  ["C2 template edit adding 500B (annotation class)", [tool("edit", { filePath: "/work/TEMPLATE.md", oldString: "## pre-push blind audit (ballot 49d5 law)", newString: A.slice(0, 480) })], "not-drafting", false],
  ["C3 read-back via bash (content absent from command)", [tool("bash", { command: "cat /work/target.md | wc -c" })], "not-drafting", false],
  ["C4 bash heredoc full body, before mtime (F-W1a)", [tool("bash", { command: `cat <<'EOF' > /work/new.md\n${A}\nEOF` })], "drafting", true],
  ["C5a fragmented drafting 67% (5 parts x 1.6KB)", Array.from({ length: 5 }, (_, i) => tool("write", { filePath: "/work/x" + String(i), content: A.slice(i * 1600, (i + 1) * 1600) })), "drafting", true],
  ["C5b fragmented drafting only 25% (minority = clean by design)", Array.from({ length: 4 }, (_, i) => tool("write", { filePath: "/work/y" + String(i), content: A.slice(i * 768, (i + 1) * 768) })), "not-drafting", false],
  ["C6 copy of artifact AFTER mtime (read/derive)", [tool("write", { filePath: "/work/other.md", content: A }, MT + 600_000)], "not-drafting", false],
  ["C7 timeless parts (defensive: no credit)", [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "write", input: { filePath: "/work/y", content: A } }] }] as never, "not-drafting", false],
  ["C8 sibling template packet (B wrote its own receipt)", [tool("write", { filePath: "/work/v130.md", content: B })], "not-drafting", false],
];

let conv = 0, total = 0;
for (const [name, msgs, klass, expectConvict] of cases) {
  const client = mk(new Map([["ses_x", { messages: msgs }]]));
  const v = await assessIndependence(client, "/work", "ses_x", art(A));
  const convicted = v.status === "NOT-INDEPENDENT";
  total += 1; conv += convicted ? 1 : 0;
  const okv = convicted === expectConvict ? "OK " : "MISMATCH";
  console.log(`${okv} ${name} => ${v.status} [expected ${expectConvict ? "convict" : "clean"}] ${convicted ? "| " + v.evidence.slice(0, 90) : ""}`);
}
// C9: 60% boundary — matched fractions at 55% and 65% of sampled windows
for (const frac of [0.55, 0.65]) {
  const head = A.slice(0, Math.floor(A.length * frac));
  const client = mk(new Map([["ses_x", { messages: [tool("write", { filePath: "/work/partial.md", content: head })] }]]));
  const v = await assessIndependence(client, "/work", "ses_x", art(A));
  console.log(`C9 union ${Math.round(frac * 100)}% of full text => ${v.status}`);
}
console.log(`probe matrix: ${conv}/${total} convicted`);
