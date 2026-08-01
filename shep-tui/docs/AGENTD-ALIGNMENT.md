# shep-tui ⇄ flock-agentd: alignment decision

**Status:** accepted and implemented locally — release tag pending.
**Author:** shep-tui side.
**Date:** 2026-07-12.
**Audience:** whoever owns `flock/agentd` and `apps/orchestrator`.

This document records why shep-tui was broken against agentd 0.3.0, the alignment decision,
and the implementation now shared by `flock`, `flock-agentd`, and `shep-tui`.

---

## 1. What was broken, concretely

Before this alignment, shep-tui could not connect to agentd 0.3.0 **at all** — not list,
not attach, not PTY. It was rejected on the first frame.

`flock/agentd/internal/server/server.go:141`:

```go
if c.challenge != nil || c.authed || ctrl.ProtocolVersion != proto.ProtocolVersion {
    c.reject("unsupported agentd protocol version")
    return
}
```

agentd was `proto.ProtocolVersion = 2` while shep-tui sent `1`, so every connection was
refused immediately.

Four distinct changes landed in agentd that shep-tui does not implement:

| # | Change in agentd | shep-tui before alignment | Consequence |
|---|---|---|---|
| 1 | `ProtocolVersion = 2`; `COMPATIBILITY.json` declares `"supportedProtocolVersions": [2]` — v1 is **not** accepted | sends `protocolVersion: 1`; `internal/compat.MinAgentdProtocol = 1` | hard reject, nothing works |
| 2 | The `secret` field is **deleted** from the wire. Replaced by a 3-leg replay-resistant handshake: `hello` → `challenge` → `authenticate` → `helloOk`, with HMAC-SHA256 MACs (`internal/controlauth`) binding both nonces, node ID, daemon version and the capability list | sends `Secret: secret` on `hello` — a field the daemon no longer has | auth impossible |
| 3 | Client must send a `nodeId` **matching the daemon's** (`--node-id`; defaults to `development-local` only in insecure dev mode). Mismatch is rejected *before* the daemon reveals anything | no concept of a node ID; no config for it | cannot handshake even with the right secret |
| 4 | `helloOk` returns negotiated `capabilities`; credential rotation exists (`credentialRotated`, `newCredential`) | ignores both | no capability gating, no rotation support |

### What did **not** change (the good news)

- The frame format is identical: `[uint32 len][type byte][payload]`.
- Session-tagged PTY payloads (`EncodeData` / `DecodeData`, `[u16 sidLen][sid][bytes]`)
  already exist **identically** on both sides.
- The session ops (`open`, `close`, `subscribe`, `resize`, `list`, `status`, `exit`) are
  substantially unchanged.

**So this is a handshake replacement, not a rewrite.** The expensive part is not the fix.
The expensive part is that we didn't find out until runtime.

---

## 2. Why it drifted (the actual problem)

`shep-tui/internal/proto/proto.go` is a **hand-copied mirror**. Its own header says so:

```go
// Package proto is the flock-agentd wire format (mirrors flock/agentd/internal/proto).
```

Nothing enforces the mirror. agentd changed; the copy didn't; no build failed, no test
failed, no CI job complained. The break surfaced as a confusing runtime rejection.

There were **three** implementations of this protocol:

| Consumer | Language | Protocol | Contract-aware? |
|---|---|---|---|
| `flock/agentd` | Go | **v2** — source of truth | owns `COMPATIBILITY.json` |
| `apps/orchestrator` | TS | **v2** (`nodes/agentd/protocol.ts`, `nodes/agentd/control-auth.ts`) | yes — `packages/shared/src/agentd-compatibility.ts`, `nodes/node-preflight.ts` |
| **`shep-tui` before alignment** | Go | **v1 — stale** | **no** |

shep-tui is the only consumer that is neither generated from, nor validated against, the
contract. That is the whole bug. It is also the only Go consumer *outside* the agentd
module — and Go's `internal/` rule is precisely what forced it to copy instead of import.

**The orchestrator got this right and shep-tui didn't.** We are not proposing a new
mechanism; we are proposing shep-tui adopt the one that already exists.

---

## 3. Accepted design

`proto` and `controlauth` are promoted out of `flock/agentd/internal/` so every Go client
imports the same public contract.

```
flock/agentd/
  internal/proto/        ->  proto/          (moved; no behavior change)
  internal/controlauth/  ->  controlauth/    (moved; no behavior change)
  internal/…                                 (everything else stays internal)
```

That is the entire request. Reasons it must be agentd's change and not ours:

- Go **forbids** importing another module's `internal/…`. This is a language rule, not a
  preference. As long as those packages are `internal`, every out-of-module Go client is
  *structurally forced* to hand-copy the wire format. shep-tui's mirror is a symptom.
- These two packages are already a **published contract in everything but name** — the TS
  orchestrator reimplements both of them by hand (`protocol.ts`, `control-auth.ts`).
  They are the public surface of the daemon; `internal/` is now mislabeling them.
- Everything genuinely internal (`session`, `identity`, `sandbox`, `server`, `acp`,
  `status`, `layout`, `metrics`, `agentpath`) **stays** `internal/`. This does not open the
  daemon up; it exposes exactly the two packages that define the wire.

### Also required for shep-tui to `require` it

The module path must be resolvable. Today:

```go
// flock/agentd/go.mod
module flock-agentd     // not a fetchable path
go 1.25.0
```

Two options, agentd's choice:

- **(a)** rename to `github.com/billiondollarsolo/flock/agentd` (matches the git remote),
  and tag releases (`agentd/v0.3.0`). Cleanest; lets shep-tui pin a real version.
- **(b)** keep the bare name and have shep-tui use a `replace` directive to the sibling
  checkout. Works today in this monorepo layout, but means shep-tui cannot be built
  without the `flock` repo checked out next to it.

We selected **(a)**. The module is now `github.com/billiondollarsolo/flock/agentd`.
shep-tui temporarily uses a sibling `replace` directive until `agentd/v0.3.0` is
published; that directive is removed when the module tag exists.

### Constraints we've verified, so nobody gets surprised

- **Go version**: agentd is `go 1.25.0` / toolchain `go1.25.12`; shep-tui is `go 1.22`.
  Importing agentd forces shep-tui to bump its `go` directive to ≥ 1.25. That's on us,
  not you — flagging it so it isn't discovered mid-review.
- **Zero behavior change.** This is a package move. No wire change, no API change, no
  semantic change. `git mv` + update import paths within agentd + `go test ./...`.
- **No new dependency for agentd.** agentd does not depend on shep-tui and never will;
  the arrow points one way.

---

## 4. How the three of us stay aligned afterwards

Three layers, cheapest-failing first. Layer 1 is the one that actually matters.

### Layer 1 — compile-time (kills the entire bug class)

shep-tui **deletes** `internal/proto` and imports `agentd/proto` + `agentd/controlauth`
directly.

```go
import (
    "github.com/billiondollarsolo/flock/agentd/proto"
    "github.com/billiondollarsolo/flock/agentd/controlauth"
)
```

After this, a protocol change in agentd is a **compile error** in shep-tui, not a runtime
rejection. `ProtocolVersion` cannot be stale because there is only one of it. The MAC
construction cannot drift because there is only one of it. This is the fix; the rest is
defense in depth.

### Layer 2 — the release contract (`COMPATIBILITY.json`)

agentd already owns a release contract, and the orchestrator already enforces it via
`packages/shared/src/agentd-compatibility.ts`:

```json
{
  "schemaVersion": 1,
  "minimumDaemonVersion": "0.3.0",
  "preferredProtocolVersion": 2,
  "supportedProtocolVersions": [2],
  "requiredCapabilities": ["pty", "resize", "scrollback", "status", "node-info"],
  "supportWindow": { "minorReleases": 1, "minimumDays": 90 }
}
```

shep-tui imports `agentd/compatibility`. That package is generated from
`COMPATIBILITY.json`, and the release check fails if generated policy drifts. It enforces
the same minimum version, protocol set, and required capabilities as the orchestrator.

Concretely, shep-tui gains what the orchestrator's `node-preflight` already has: on
`helloOk`, verify `daemonVersion >= minimumDaemonVersion` and that
`requiredCapabilities ⊆ capabilities`, and refuse with an actionable
*"upgrade flock-agentd to ≥ X"* rather than a cryptic reject.

**Ask of agentd:** treat `COMPATIBILITY.json` as the single release-owned contract and
keep bumping it when the wire changes. You already do. Nothing new.

### Layer 3 — a live contract test in CI

A test that boots the **real** `flock-agentd` binary on a temp unix socket and drives a
real client through `hello → challenge → authenticate → helloOk → open → resize → close`.

This is the layer that catches semantic drift a shared struct cannot — e.g. "the MAC now
also binds capabilities", which compiles fine and fails at runtime. It is the test that
would have caught **this** break the day it landed.

Where it lives is a judgement call:
- in **shep-tui** CI (needs an agentd binary — build from the sibling checkout, or download
  the release artifact); or
- in **flock** CI as a downstream-consumer check (agentd already has an integration gate:
  `350f2c5 ci: enforce integration security and release gates`).

**Our recommendation:** put it in `flock` CI. A protocol change should break the PR that
*makes* it, in the repo that makes it — not a different repo, days later. This is the single
highest-leverage line in this document.

---

## 5. Completed work

**`flock` / agentd:**

1. Promoted `proto` and `controlauth`; all agentd imports use the public module path.
2. Renamed the module to `github.com/billiondollarsolo/flock/agentd`.
3. Added generated `agentd/compatibility` policy with release drift validation.
4. Retained mutual authentication on every transport.
5. Kept credential rotation owned by the trusted orchestrator/control authority.

**shep-tui:**

1. Bumped to Go 1.25 and imports the shared packages.
2. Deleted its hand-copied protocol.
3. Implements the full v2 mutual-MAC handshake with authenticated capability checks.
4. Supports `agentd_node_id` and protected `agentd_secret_file` configuration plus env overrides.
5. Uses the generated agentd policy for version, protocol, and capability enforcement.
6. Added a shared-contract handshake test and retained the real-daemon PTY lifecycle test.

**Release follow-up:** publish `agentd/v0.3.0`, remove shep-tui's local `replace`, and add
the standalone TUI repository to the release CI downstream matrix once it is published.

---

## 6. Decisions on the open questions

These are genuine questions, not rhetorical ones. Answers change what we build.

1. **The local Unix socket keeps the full mutual-MAC handshake.**
   agentd's own comment (`main.go`, on the TCP-listener guard) says:

   > *"The unix socket (local node) is already protected by 0600 file perms, so it needs no secret."*

   Socket permissions are defense in depth, not an alternate trust protocol. Prepared
   nodes require a credential; explicit same-user development mode may use an empty
   credential but still performs the nonce/MAC exchange.

2. **Node identity is provisioned out-of-band.**
   The daemon rejects a mismatch *before* disclosing its own ID (correctly — that's the
   point). So the client must be told out-of-band. Is there an intended discovery path
   (a state file, a `nodeinfo` on the socket, the `--node-id` echoed somewhere), or is
   Secure nodes use `agentd_node_id` / `FLOCK_AGENTD_NODE_ID`. Standalone development
   defaults to the daemon's documented `development-local` identity.

3. **Credential rotation remains control-authority-owned.** shep-tui does not request
   rotation or persist plaintext. It reads a protected credential file on connection;
   reconnecting naturally picks up a rotation performed by the owner.

4. **The v1 removal is intentionally hard.** This is greenfield, pre-1.0 development and
   v1 transmitted a plaintext shared secret. The published compatibility manifest is the
   support promise from v2 onward.

---

## 7. What we are explicitly *not* asking for

- No change to the wire format, the handshake, or the security model. The v2 handshake
  looks right and we are not litigating it.
- No dependency from agentd onto shep-tui, ever.
- No de-`internal`-ing of anything except `proto` and `controlauth`.
- No work in the `flock` repo beyond §5. shep-tui absorbs the rest.

---

## Appendix — current evidence

| Claim | Source |
|---|---|
| v1 is hard-rejected | `flock/agentd/internal/server/server.go:141` |
| protocol is v2 | `flock/agentd/proto/proto.go` |
| shep-tui uses the shared protocol | `shep-tui/internal/backend/local/client.go` imports `flock/agentd/proto` |
| plaintext `secret` is absent from the wire | `flock/agentd/proto/proto.go` |
| 3-leg handshake + MAC | `flock/agentd/internal/server/server.go`, `flock/agentd/controlauth/controlauth.go` |
| `nodeId` must match | `flock/agentd/internal/server/server.go:145` |
| dev default node id | `flock/agentd/main.go:162` (`development-local`) |
| release contract | `flock/agentd/COMPATIBILITY.json`, `flock/agentd/VERSION` (0.3.0) |
| orchestrator already v2 | `flock/apps/orchestrator/src/nodes/agentd/protocol.ts:7` |
| orchestrator enforces the contract | `flock/packages/shared/src/agentd-compatibility.ts`, `apps/orchestrator/src/nodes/node-preflight.ts` |
| the copied TUI protocol is gone | `shep-tui/internal/proto` removed; Go tests import the shared package |
| PTY framing already matches | `EncodeData`/`DecodeData` present and identical in both `proto.go` files |

---

## 9. Addendum (2026-07-12): credential discovery — IMPLEMENTED

The shared-contract work landed and is verified against a live agentd 0.3.0 (full
v2 handshake, list, open, PTY, resize, close, status). Two follow-ups were then found
and have now **both been implemented** — 9.1 and 9.2 below touch the `flock` repo
(`run-dev.sh`, `agentd/compatibility`), and are described here for review.

### 9.1 The credential is invisible to every other local process

A user who runs `shep-tui` against a daemon started by `run-dev.sh` gets:

```
agentd hello failed: unknown control credential
```

Cause: `run-dev.sh` reads `FLOCK_AGENTD_SECRET` out of `.env.dev.local` and passes it
to agentd **through the environment only** (`run-dev.sh:106,128`). An environment
variable is visible to the daemon and to nothing else. Any other local client — shep-tui,
a debug tool, a second terminal — has no way to discover the credential its own machine's
daemon is using.

The intended model (and the right one) is:

- **agentd already exists** → the client must *adopt* the credential whoever started it assigned.
- **no agentd exists** → the client may *start* one, and then it owns the credential.

shep-tui now implements both halves:

- `shep-tui up` mints a 256-bit credential, persists it `0600`, and starts the daemon with it.
- Credential resolution walks: explicit secret → explicit `agentd_secret_file` →
  **well-known file** `$XDG_RUNTIME_DIR/flock-agentd.secret` → empty.

Adoption is verified: with the daemon's secret in that file and **no env vars set at all**,
`shep-tui doctor` reports `hello: ok (daemon 0.3.0, proto 2)`.

**DONE in `flock`:** `run-dev.sh` now publishes the credential to that well-known 0600 file
(and removes it on shutdown, so a stale secret never outlives the daemon that issued it).
No security change — the secret moves from an invisible env var to an owner-only file,
which is what makes a locally-started daemon adoptable at all.

Verified: with the credential published and **no env vars set at all**, `shep-tui doctor`
reports `hello: ok (daemon 0.3.0, proto 2)` and the live contract suite passes.

Scoping caveat found while testing: the well-known credential is adopted **only** for the
daemon on the default socket. A profile pointed at another daemon (`--socket`) must not
present it — that would authenticate against the wrong node.

```bash
# run-dev.sh, alongside the existing AGENTD_SECRET= line
AGENTD_SECRET_FILE="${XDG_RUNTIME_DIR:-/tmp}/flock-agentd.secret"
umask 077 && printf '%s' "$AGENTD_SECRET" > "$AGENTD_SECRET_FILE"
# …then start agentd with: --secret-file "$AGENTD_SECRET_FILE"
```

Until that lands, a flock-started daemon needs the secret exported by hand:

```bash
export FLOCK_AGENTD_SECRET=$(grep '^FLOCK_AGENTD_SECRET=' flock/.env.dev.local | cut -d= -f2-)
```

### 9.2 `compatibility/policy_gen.go` has no generator

`flock/agentd/compatibility/policy_gen.go` is headed *"Code generated from
agentd/COMPATIBILITY.json; DO NOT EDIT"* — but there is **no generator, no `go:generate`
directive, and no test comparing it to the JSON**. Its values are correct today; nothing
enforces that they stay correct.

This is the original bug re-created one level up: a hand-maintained copy of a contract,
labelled as generated, with nothing checking it. Edit `COMPATIBILITY.json` and the Go
policy silently goes stale — and the Go policy is what shep-tui gates the handshake on.

**DONE in `flock`:** `go:embed` cannot reach a parent directory, and `agentd/COMPATIBILITY.json`
cannot move (its path is baked into `docker/Dockerfile.orchestrator`, `.github/workflows/release-images.yml`,
`deploy.int.test.ts` and the docs). So instead:

- `agentd/cmd/gen-compatibility` renders the JSON into `policy_gen.go` (`go generate ./compatibility`).
  It reproduces the previously hand-written file byte-for-byte, so there is no behavior change.
- `TestPolicyMatchesCompatibilityJSON` fails the build when the two diverge, naming the fix.
  Verified by bumping `minimumDaemonVersion` in the JSON: the test fails with a diff.
- `TestPolicyIsSelfConsistent` rejects a policy whose preferred protocol is not in its supported set.

The originally-proposed embed, for reference:

```go
package compatibility

import (
    _ "embed"
    "encoding/json"
)

//go:embed COMPATIBILITY.json   // requires the file inside the package dir, or a copy step
var policyJSON []byte

func Current() Policy { /* json.Unmarshal(policyJSON, …) */ }
```

Failing that, a `TestPolicyMatchesCOMPATIBILITYJSON` that parses the JSON and compares it
field-by-field to `Current()` closes the hole just as well.
