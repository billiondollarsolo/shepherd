# Flock documentation

The map for understanding the platform.

> **Building Flock?** Start at **[roadmap.md](roadmap.md)** — the authoritative
> end-to-end vision + execution plan (phased tasks with success criteria, tests, and
> engineering standards baked in) for taking Flock to the elite web-native platform.

New here? Read in this order:

1. **[Architecture](architecture.md)** — the three components and how a session flows
   end to end. Start here.
2. **[Agent integration matrix](agent-integration-matrix.md)** — exactly what Flock
   captures from each agent (Claude / Codex / OpenCode / Gemini / Grok) and the
   mechanism behind each signal. The authoritative "how well do we work with agent X."
3. **[flock-agentd design](flock-agentd-design.md)** — the node daemon: why it exists
   (the tmux replacement) and how the raw-PTY + status + metrics model works.
4. **[Deployment](deployment.md)** — the production Docker Compose stack in depth
   (services, TLS, secrets, per-session browsers, verifying a deploy).
5. **[Releasing](releasing.md)** — public-repository setup, versioning, GHCR
   publication, verification, and operational follow-through.

## Reference

| Doc                                                              | Purpose                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                               | System overview — orchestrator ⇄ agentd ⇄ web, the status pipeline, data path                                                            |
| [agent-integration-matrix.md](agent-integration-matrix.md)       | Per-agent capability matrix + the hook/transcript mechanism for each                                                                     |
| [flock-agentd-design.md](flock-agentd-design.md)                 | Node daemon design + protocol rationale                                                                                                  |
| [deployment.md](deployment.md)                                   | Docker Compose production deploy, TLS, secrets, ops                                                                                      |
| [releasing.md](releasing.md)                                     | Release gates, GitHub/GHCR publication, verification, and public-repository checklist                                                    |
| [design-tokens.md](design-tokens.md)                             | The web UI design system — color, type, spacing tokens                                                                                   |
| [premium-single-user-roadmap.md](premium-single-user-roadmap.md) | Incremental premium roadmap: backup/recovery, history/search, health, snapshots, notifications, updates, diagnostics, and data ownership |
| [decisions/](decisions/)                                         | Architecture Decision Records (e.g. terminal renderer, browser-driving)                                                                  |

## Background / historical

These capture original intent and the build history — useful for context, not required
to run or extend Flock:

- **[`../PRD.md`](../PRD.md)** — the product requirements doc (original vision; some
  names predate the code, e.g. "Conductor" → Flock, "cockpit" → the web dashboard).
- **[specs/](specs/)** — the original TDD task breakdown the build followed.
- **[elite-readiness-plan.md](elite-readiness-plan.md)** — the hardening plan executed
  to bring the platform to production quality.

> **A note on terminology.** The codebase is **Flock**; the web dashboard's internal
> name is the **paddock**. Older docs may say "Conductor" or "cockpit" — same thing.
