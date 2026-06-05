# Flock — Draft Spec (Lisa interview notes)

> Project name: **Flock** (formerly working name "Conductor" in PRD.md). A flock of coding agents you supervise.
> Source: PRD.md (Conductor PRD Draft v1). This draft captures interview decisions layered on top of the PRD.

## Decisions captured

### Stack
- **Backend:** Node.js + TypeScript. Best fit for WS, node-pty (PTY), ssh2 (SSH), chrome-remote-interface (CDP), Prisma/Drizzle (Postgres). Client-agnostic API.
- **Frontend:** React + Vite + TypeScript. wterm React component + useTerminal hook (PRD §6.1). Tailwind + Radix/shadcn for Codex-like calm density.
- **Mobile:** PWA now + **native-ready API**. Shared TS types; native app later needs only a push-adapter (APNs/FCM). No native app in v1.

### Scope
- **v1 = Full PRD Phase 1**: tree + terminal + status/hooks (3 agents) + OSC/PTY fallback + WS live status + Web Push + Postgres registry/event log + auth/audit foundation + 3-layer per-session browser (CDP screencast) + Docker Compose.
- Supervisor-agent (§9) = Phase 2. Enterprise (SSO/RBAC/multi-tenant) = Phase 3.

### Node / sequencing
- **Both local + SSH in parallel tracks** behind a shared `NodeTransport` contract; same test suite runs against both impls. Orchestrator host is the "local" node (FR-N5, no SSH hop).

### Browser
- Per-session Chrome containers **always run on the orchestrator VPS** (Docker socket on VPS). Keeps nodes 100% dumb (§6.4). Agent reaches CDP over the reverse tunnel; Layer C screencast is local to orchestrator.

### Testing (TDD)
- **Layered pyramid:** Vitest unit (status mapping, translators, reducers — pure logic, TDD'd first). Dockerized integration (real tmux/ssh/Postgres). Playwright e2e (UI shell). Per-agent hook **contract tests** (recorded payloads → status enum).

### Design fidelity
- **Codex-faithful skeleton + distinctive Flock polish.** Match spatial model exactly (3 regions + bottom drawer + Cmd+K/J), calm density, light/dark, Codex terminology. Use frontend-design skill for a production-grade original Flock identity (not pixel clone). Honest per §12.4.
- **Center pane = terminal-first**; conversation/summary feel lives in the right activity sidebar (away-summary, plan, timeline). Center is a tab group: Terminal (default) | Browser (Layer C) | Diff (FR-UI4).

### Auth & secrets
- **First-run admin setup + invite.** argon2/bcrypt hashing, httpOnly secure session cookies, TLS required. Roles admin/member (FR-A2).
- **App-level encryption at rest** for SSH private keys + hook tokens (libsodium/AES-GCM, master key from env/secret file); ciphertext in Postgres, never plaintext. Log key use (FR-A3). Pluggable for KMS/Vault later.

## TODO
- Hook config injection strategy (session-scoped config dirs, §11.3)
- Reconcile-on-reconnect acceptance per agent (§7.2, §11.4)
- Screencast performance controls / caps (NFR-PERF3)
- wterm OSC spike + browser-harness spike placement
- User stories (US-1..N) + verifiable acceptance criteria
- Implementation phases within v1; verification commands
