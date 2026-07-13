# Decision: Security threat model and product boundary

Status: Accepted
Date: 2026-07-11

## Context

Shepherd is a single-operator control plane for shell-capable coding agents. A coding
agent routinely reads repositories, invokes package managers, runs build scripts,
starts subprocesses, and follows instructions from source files. Treating the agent
process or repository as trusted would make Shepherd's most important isolation claims
illusory.

The current code also contains historical administrator/member surfaces even though
the product is intentionally single-user. Keeping an implied multi-tenant boundary
without consistently enforcing it creates more risk than a smaller explicit model.

## Decision

### Trusted components

- The one human installation owner and their authenticated browser are trusted.
- The orchestrator host, PostgreSQL service, Shepherd master key, release artifacts, and
  Shepherd control identity are trusted.
- Root on the orchestrator or a managed node is installation compromise and is outside
  Shepherd's isolation guarantee.

### Untrusted components

- Repository contents, build scripts, dependencies, MCP servers, agent instructions,
  tool output, and every subprocess launched by an agent are potentially hostile.
- An agent process is untrusted even when the coding-agent vendor is trusted.
- Tailnet membership, LAN reachability, and knowledge of a session identifier are not
  application authorization.
- Managed nodes are trusted to enforce their operating-system boundary, but an agent
  running on a node is not trusted with node-control authority.

### Required isolation

- A compromised agent must not obtain agentd control credentials or attach to, input
  into, resize, terminate, or read another session through agentd.
- Callback authority is limited to the issuing session.
- Agent-to-agent orchestration is disabled by default and requires a separate,
  explicitly scoped capability.
- Project-scoped capabilities cannot cross projects, and destructive capabilities are
  independently grantable and revocable.
- Agent-only plaintext capabilities and their hashes never leave the orchestrator for
  the browser.
- SSH credentials, the master key, Docker control, and control-plane environment
  values are never available to an agent process.
- Missing identity, ownership, Origin policy, sandbox support, or protocol negotiation
  fails closed.

### Human-user model

Shepherd supports one owner account per installation. Human multi-tenancy and isolation
between mutually untrusted human users are out of scope. Historical member, invite,
and implicit administrator-bypass behavior will be removed rather than presented as a
supported security boundary.

### Supported network modes

1. Production HTTPS/WSS through the bundled Caddy deployment.
2. Tailnet HTTPS using a verified hostname/certificate and restrictive Tailscale
   grants or ACLs.
3. Localhost development with explicitly enumerated Origins.

Raw public or LAN HTTP is unsupported. Tailnet-IP HTTP may be used only for temporary
development, must remain tailnet-restricted, and does not disable WebSocket Origin
validation.

## Security invariants

1. Network traffic is encrypted outside a same-host protected socket boundary.
2. Agent and control identities are distinct.
3. Capabilities are least-privilege, scoped, expiring, revocable, and auditable.
4. Public DTOs are allowlisted and contain no control-plane secret material.
5. Every supported deployment mode has an explicit Origin and cookie policy.
6. Security boundaries have negative integration tests using a shell-capable
   adversarial agent.
7. A release is not considered hardened without verified backup/restore and candidate
   image smoke tests.

## Consequences

- Secure node enrollment requires an installation step with administrative privileges;
  silently falling back to a same-UID user daemon is not acceptable.
- Some convenience features become explicit capabilities rather than implicit agent
  powers.
- The web, API, database, and tests can be simplified around one human owner.
- Existing development data may require destructive migrations because Shepherd is
  pre-1.0 and does not preserve obsolete compatibility surfaces.
- Documentation must distinguish transport encryption from agent containment.

## Verification

The permanent adversarial suite must prove that an agent cannot read node-control
credentials, connect to agentd, use callback credentials for orchestration, cross a
project boundary, attach to another PTY, reach Docker control, or recover agent-only
credentials from browser responses.

## Revisit when

- Shepherd intentionally adds multiple mutually untrusted human operators, or
- a supported non-Linux node platform cannot implement the required control/runtime
  identity separation.
