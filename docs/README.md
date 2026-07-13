# Shepherd documentation

The map for understanding the platform.

> **Name transition:** Shepherd was previously named Flock. Technical identifiers retain
> the `flock` prefix in this release; commands, service names, environment variables,
> package paths, images, and repository URLs remain unchanged.

> **Building Shepherd?** Start at **[roadmap.md](roadmap.md)** — the authoritative
> end-to-end vision + execution plan (phased tasks with success criteria, tests, and
> engineering standards baked in) for taking Shepherd to the elite web-native platform.

New here? Read in this order:

1. **[Architecture](architecture.md)** — the three components and how a session flows
   end to end. Start here.
2. **[Agent integration matrix](agent-integration-matrix.md)** — exactly what Shepherd
   captures from each agent (Claude / Codex / OpenCode / Gemini / Grok) and the
   mechanism behind each signal. The authoritative "how well do we work with agent X."
3. **[flock-agentd design](flock-agentd-design.md)** — the node daemon: why it exists
   (the tmux replacement) and how the raw-PTY + status + metrics model works.
4. **[Deployment](deployment.md)** — the production Docker Compose stack in depth
   (services, TLS, secrets, per-session browsers, verifying a deploy).
5. **[Releasing](releasing.md)** — public-repository setup, versioning, GHCR
   publication, verification, and operational follow-through.
6. **[Backup and recovery](backup-and-recovery.md)** and
   **[Operations and diagnostics](operations-and-diagnostics.md)** — verified vaults,
   health semantics, support bundles, and runtime bounds.

## Reference

| Doc                                                              | Purpose                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                               | System overview — orchestrator ⇄ agentd ⇄ web, the status pipeline, data path                                                            |
| [agent-integration-matrix.md](agent-integration-matrix.md)       | Per-agent capability matrix + the hook/transcript mechanism for each                                                                     |
| [flock-agentd-design.md](flock-agentd-design.md)                 | Node daemon design + protocol rationale                                                                                                  |
| [deployment.md](deployment.md)                                   | Docker Compose production deploy, TLS, secrets, ops                                                                                      |
| [releasing.md](releasing.md)                                     | Release gates, GitHub/GHCR publication, verification, and public-repository checklist                                                    |
| [backup-and-recovery.md](backup-and-recovery.md)                 | Encrypted vault creation, verification, isolated restore, rollback, and drills                                                           |
| [operations-and-diagnostics.md](operations-and-diagnostics.md)   | Health/readiness, owner diagnostics, redaction, and support bundle                                                                       |
| [operations-memory-bounds.md](operations-memory-bounds.md)       | Required bounds and cleanup policy for every process-lifetime collection                                                                 |
| [design-tokens.md](design-tokens.md)                             | The web UI design system — color, type, spacing tokens                                                                                   |
| [premium-single-user-roadmap.md](premium-single-user-roadmap.md) | Incremental premium roadmap: backup/recovery, history/search, health, snapshots, notifications, updates, diagnostics, and data ownership |
| [decisions/](decisions/)                                         | Architecture Decision Records (e.g. terminal renderer, browser-driving)                                                                  |

Security boundary decisions:

- [Threat model and product boundary](decisions/security-threat-model.md)
- [Privilege-separated agentd control plane](decisions/agentd-privilege-separation.md)

## Background / historical

Historical drafts and build ledgers are catalogued in
**[archive/README.md](archive/README.md)**. They are deliberately excluded from the
authoritative reading path.

> **A note on terminology.** The product is **Shepherd**; the web dashboard's internal
> name is the **paddock**. Older docs may say “Flock,” “Conductor,” or “cockpit.” Literal
> Compatibility-sensitive `flock-*` identifiers remain current during the surface-name
> transition; public container images use `shepherd-*`.
