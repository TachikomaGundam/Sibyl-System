// provenance: W2 缺席即伤残 (absence-as-disability) primitive, handoff
// HANDOFF-SIBYL-20261004.md. The swarm first campaign (2026-10-04, 8 workers
// 7 dead) showed the failure class: a worker died mid-run, cast NO durable
// record, and the tally displayed the ballot as if participation had happened.
// Kin of the 2026-09-29 counting accident (absence counted as a reject).
//
// The law this module encodes:
//   - every declared voter/worker must leave a TERMINAL ROW (ok|error|timeout
//     + one-line detail) in the run space before any tally is honored;
//   - a declared seat WITHOUT a terminal row is dead-without-record: it is
//     counted on the receipt face and forces the run to CANNOT_ANSWER —
//     it is never folded into an approve/reject vote, and never silently
//     dropped from the declared set either (absence-passes and
//     absence-rejects are the same disease, two faces).

/** The closed terminal-row vocabulary. timeout is carved out of error because
 * an expired budget names a ruler-side wound; an error names the engine. */
export const TERMINAL_STATUSES = ["ok", "error", "timeout"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type TerminalRow = {
  task: string;
  worker: string;
  status: TerminalStatus;
  session: string;
  detail: string;
};

/** Collapse to one line and cap length — the row must never smuggle a stack
 * trace or a newline into the ledger face. */
export const TERMINAL_DETAIL_MAX = 240;

export function sanitizeDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TERMINAL_DETAIL_MAX ? flat : `${flat.slice(0, TERMINAL_DETAIL_MAX)}…`;
}

/** timeout-class failures are ruler wounds; everything else is an engine error. */
export function classifyFailure(error: string): TerminalStatus {
  return /timeout|timed out|deadline/i.test(error) ? "timeout" : "error";
}

/** One canonical line, appended EOF-only to the run's TERMINALS.txt. */
export function formatTerminalRow(at: Date, row: TerminalRow): string {
  return (
    `ts=${at.toISOString()} task=${row.task} worker=${row.worker} status=${row.status} ` +
    `session=${row.session.length > 0 ? row.session : "-"} detail=${sanitizeDetail(row.detail)}`
  );
}

type ParsedRow = { task: string; worker: string; status: TerminalStatus; session: string; detail: string; line: number };

/** Line-oriented parse: malformed lines are SKIPPED (never fatal — swarm
 * crash lesson), the LAST well-formed row per task wins (resume appends). */
export function parseTerminalRows(text: string): Map<string, ParsedRow> {
  const byTask = new Map<string, ParsedRow>();
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const task = /(?:^| )task=(\S+)/.exec(line)?.[1];
    const statusRaw = /(?:^| )status=(\S+)/.exec(line)?.[1];
    if (task === undefined || statusRaw === undefined) continue;
    const status = (TERMINAL_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as TerminalStatus)
      : undefined;
    if (status === undefined) continue;
    byTask.set(task, {
      task,
      worker: /(?:^| )worker=(\S+)/.exec(line)?.[1] ?? "-",
      status,
      session: /(?:^| )session=(\S+)/.exec(line)?.[1] ?? "-",
      detail: /(?:^| )detail=([\s\S]*)$/.exec(line)?.[1] ?? "",
      line: i + 1,
    });
  }
  return byTask;
}

/** Declared seats with NO terminal row anywhere = dead-without-record.
 * Unknown/unexpected rows are not asked about here (the tally never widens
 * the declared set from the ledger alone). */
export function deadWithoutRecord(declaredTaskIds: readonly string[], rows: ReadonlyMap<string, unknown>): string[] {
  return declaredTaskIds.filter((id) => !rows.has(id));
}

/** Receipt-face label, used in the FIRST line of every tool reply. */
export function deadFaceCount(dead: readonly string[]): string {
  return `dead-without-record=${String(dead.length)}`;
}
