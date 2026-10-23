# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest `1.x` | ✅ |
| older 1.x  | ❌ — the project is maintained fail-closed by a small crew; please upgrade first and re-test |

## Reporting a vulnerability

Report privately via a **GitHub security advisory**:
<https://github.com/TachikomaGundam/Sibyl-System/security/advisories/new>

Do **not** open a public issue for anything exploitable. This is a single-maintainer
project — we aim to acknowledge within a week and will coordinate disclosure timing
with you; a fix lands as its own release wheel with the advisory referenced.

## What the plugin touches (data-egress map)

- `sibyl_consult` / `sibyl_swarm` / `sibyl_review` / `sibyl_audit` send the artifact
  text and prompts to **the model providers configured on your own host**
  (`modelPool` options). Treat that pool as your data boundary; the package ships
  no vendor model ids and pins no device-side authorizations.
- `sibyl_time_probe` sends **HEAD requests with zero payload** to time sources.
  Since 1.5.0 every URL passes an egress gate before any fetch: non-http(s)
  schemes, userinfo, non-default ports, IPv4/IPv6 reserved families (loopback,
  private, link-local/cloud-metadata, CGNAT, multicast/reserved, ULA, and
  IPv4-embedded mapped/compat/6to4 forms re-checked), single-label hosts and
  internal name suffixes are refused by rule name. Blocked sources become failed
  receipts — a blocked source never counts as consent.
- `sibyl_attribute` performs **zero** network or git calls of its own — it
  compares strings you captured elsewhere.
- Writes are confined to the state paths (`~/.sibyl/…`) and lane run dirs; every
  plugin-created directory is mode `0700`.
- Voter/worker turns run with `bash`, `edit`, `write` disabled per prompt.

## Hardening posture

- Verdicts are fail-closed by design; there is no lenient mode.
- Release wheels pass the standing doors: `ship.sh` (typecheck, offline suite,
  build, smoke, tarball portability scan), `npm audit --audit-level=high`, the
  border gate on the committed face, and the W4 tag-object release law — since
  1.5.0 the hook additionally refuses home-path and email shapes inside pushed
  tag message bodies.
- `dependabot.yml` polls npm and GitHub Actions dependencies weekly.

## Named limitations (honest disclosure, not closed gaps)

- **DNS-rebinding-class SSRF is not filtered.** The gate judges URL *literal*
  shapes; a public hostname whose DNS answer points into internal space still
  receives a HEAD request. The fetch API cannot pin a connection to a
  pre-verified address (resolve-then-connect is TOCTOU). Residual risk is
  bounded: HEAD, zero payload, no credential, redirects not followed
  (`redirect: "manual"`).
- The model-pool trust boundary is the operator's configuration, not the plugin.
- The release laws (W4 receipt-in-tag, tag-body hygiene) are enforced by a
  **client-side pre-push hook**: every clone installs it explicitly
  (`scripts/install-hooks.sh`; the package ships no hooks), and `--no-verify`
  bypasses it. They discipline this project's own release wheels — they are
  not, and do not claim to be, server-enforced protection.
- Coverage floors are a quality ratchet, not a security proof.
