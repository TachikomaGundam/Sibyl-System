// provenance: original clean-room Sibyl-System implementation (v1.4.0), no external code copied.
//
// Private-directory discipline (2026-10-23 owner-approved release round, third-party
// audit finding MEDIUM 'world-readable run dirs under /tmp'): every directory the
// plugin creates for run state or sandboxes must be unreachable to group/other —
// artifacts (prompts, transcripts, candidate code) may be unpublished. mode 0700 at
// mkdir PLUS an explicit chmod on the leaf: mkdir's mode is umask-filtered on some
// platforms and recursive:true does not re-mode an already-existing leaf, so the
// chmod makes the invariant hold regardless of umask or pre-existing state.
// Files inside keep default modes: the 0700 directory blocks traversal for other
// accounts, which is the effective boundary (minimal change surface).
import { chmod, mkdir } from "node:fs/promises";

export async function mkdirPrivate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
