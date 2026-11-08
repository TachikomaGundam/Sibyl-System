// provenance: original clean-room Sibyl-System implementation (v1.7 credential
// relay plumbing). Raw request/response IO for src/lane/proxy.ts, kept separate
// so the credential-policy module stays small and reviewable. No policy lives
// here: these helpers move bytes and enforce the body-size cap only.

import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export type BodyRead = { ok: true; body: Buffer } | { ok: false; status: number; code: string; message: string };

export function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (v: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolvePromise(v);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, status: 413, code: "body_too_large", message: "request body exceeds the relay limit" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ ok: true, body: Buffer.concat(chunks) }));
    req.on("error", () => settle({ ok: false, status: 400, code: "body_read_failed", message: "request stream failed before completion" }));
  });
}

function onceDrainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => resolvePromise();
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

/** Pump an upstream web stream to the role response chunk-by-chunk (SSE-safe,
 * no buffering of the whole body), applying write backpressure. A mid-stream
 * fault or a hung-up role destroys the response instead of leaving it half-open. */
export async function streamToClient(upstreamBody: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value !== undefined && !res.write(chunk.value)) {
        await onceDrainOrClose(res);
      }
    }
    res.end();
  } catch {
    // upstream died mid-stream or the role hung up: kill this response, do not fake completion
    res.destroy();
  }
}
