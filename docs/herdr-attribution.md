# Herdr attribution (Apache-2.0)

**Status:** Active  
**Date:** 2026-08-01  
**Plan:** [`master-improvement-plan.md`](./master-improvement-plan.md) (H0.2, D3, D13)

## Summary

Shepherd incorporates **adapted screen-detection rule content** and **engine ideas**
from [Herdr](https://github.com/herdrdev/herdr) (Apache License 2.0). Herdr remains a competitive
reference and upstream source of manifests/rules patterns. Shepherd does **not**
depend on the Herdr binary, server, TUI, or source tree at runtime.

- **License of upstream material:** Apache-2.0  
- **Shepherd product license:** MIT (see repo root `LICENSE`)  
- **Notices:** [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)

## What is adapted

### Manifests (rule content)

The following Shepherd-owned TOML files under
`agentd/internal/screendetect/manifests/` are **adapted from Herdr**
`src/detect/manifests/*.toml` for use with Shepherd’s Go screendetect engine:

| Shepherd path | Notes |
| --- | --- |
| `agentd/internal/screendetect/manifests/amp.toml` | Adapted |
| `agentd/internal/screendetect/manifests/antigravity.toml` | Adapted |
| `agentd/internal/screendetect/manifests/claude.toml` | Adapted |
| `agentd/internal/screendetect/manifests/codex.toml` | Adapted |
| `agentd/internal/screendetect/manifests/cursor.toml` | Adapted |
| `agentd/internal/screendetect/manifests/grok.toml` | Adapted |
| `agentd/internal/screendetect/manifests/opencode.toml` | Adapted |

Each file carries a short header pointing here. Content may diverge from upstream as
Shepherd product needs require (D13: Shepherd-owned adapted manifests).

### Engine ideas (not vendored code)

Shepherd **reimplements** a compatible TOML rule engine in Go
(`agentd/internal/screendetect/`), informed by Herdr’s detection design
(regions, matchers, priority, `visible_blocker`, `skip_state_update`,
`min_engine_version`, etc.). Prefer reimplementation + adapted manifests over
copying Herdr Rust production sources.

## What is not taken

- Herdr TUI, workspace/tab/pane identity model, or full server runtime  
- libghostty-vt or other Herdr vendored UI stacks as product UI  
- Live network/runtime fetch of Herdr assets  
- Any compile- or link-time dependency on Herdr

## Runtime dependency policy

**There is no runtime Herdr dependency.** Detection uses only Shepherd-owned
artifacts embedded or loaded by `flock-agentd`. Operators never need Herdr
installed for screendetect to run.

## Periodic import (D13)

Upstream leverage is a **human-reviewed process**, not a live sync:

1. Run `scripts/import-herdr-manifests.mjs` (or equivalent) against a sibling
   checkout at `../herdr/src/detect/manifests`.
2. Diff proposed changes into Shepherd’s adapted manifests.
3. Review for false positives/negatives, license headers, and engine compatibility.
4. Land only as reviewed patches in Shepherd.

See the script’s help text for the workflow stub.

## Related decisions

| ID | Topic |
| --- | --- |
| **D3** | Herdr TOML for rule content; engine reimplemented in Go |
| **D13** | Shepherd-owned manifests + periodic Herdr import as reviewed patches |
| **D10** | Screendetect default off until live matrix green |
| **D4 / D11** | Status authority — see [`decisions/status-authority.md`](./decisions/status-authority.md) |
