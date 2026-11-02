export interface PaperworkInput {
  tagName: string;
  pkgVersion: string | null;
  receiptExists: boolean;
  receiptText: string | null;
}

export interface PaperworkResult {
  ok: boolean;
  problems: string[];
}

export function evaluatePaperwork(input: PaperworkInput): PaperworkResult;

export function run(opts: { tagRef: string; root?: string }): PaperworkResult;
