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
- Development-server content exposed by Preview is untrusted. Hostname mode gives each
  forward a random separate hostname. Private port-pool mode gives it a separate browser
  origin but shares the control-plane cookie host; that weaker mode is restricted to an
  explicitly acknowledged trusted Tailnet/LAN deployment.
- Preview never receives Shepherd login/setup/capability cookies, Authorization,
  forwarding, client-identity, or Referer headers. An upstream cannot set reserved
  Shepherd cookies, clear the control-plane cookie site, or install a service worker.
- A Preview may dial only the exact numeric loopback port saved for an owner-controlled
  project on its current node. It is connection/byte/time bounded, expiring, immediately
  revocable, auditable, and independent of any one agent session.
- Every unsafe control-plane browser method requires an exact configured Origin. Missing
  Origin fails closed. Bearer-authenticated hooks and orchestration callbacks use narrow,
  separately tested policies. This is mandatory because SameSite cookies do not stop a
  same-host, cross-port Preview from causing a request.

### Human-user model

Shepherd supports one owner account per installation. Human multi-tenancy and isolation
between mutually untrusted human users are out of scope. Historical member, invite,
and implicit administrator-bypass behavior will be removed rather than presented as a
supported security boundary.

### Supported network modes

1. Production HTTPS/WSS through the bundled Caddy deployment.
2. Production HTTPS/WSS through an explicitly trusted external reverse proxy.
3. Deliberate private HTTP/WS on a restricted LAN or encrypted overlay, selected by a
   named deployment mode plus an explicit insecure-transport acknowledgement.
4. Localhost development with explicitly enumerated Origins.

Raw public HTTP is unsupported. Private HTTP does not disable exact WebSocket Origin
validation or application authentication, but it cannot provide transport
confidentiality, `Secure` cookies, or the `__Host-` cookie prefix. The UI and diagnostics
must keep that distinction visible. IP-only private HTTP may use a bounded, pre-published
Preview-only port pool. Apps across those ports can share application cookies because
cookies are host-scoped; hostname mode is required for mutually untrusted apps.

## Security invariants

1. Public-Internet traffic is encrypted. Any unencrypted private-network mode is
   explicit, visible, origin-restricted, and documented as accepting interception risk.
2. Agent and control identities are distinct.
3. Capabilities are least-privilege, scoped, expiring, revocable, and auditable.
4. Public DTOs are allowlisted and contain no control-plane secret material.
5. Every supported deployment mode has an explicit Origin and cookie policy.
6. Security boundaries have negative integration tests using a shell-capable
   adversarial agent.
7. A release is not considered hardened without verified backup/restore and candidate
   image smoke tests.
8. Hostname Preview never shares the control-plane hostname. Port-pool Preview may share
   the host only with global exact-Origin enforcement, duplicate-cookie rejection,
   reserved-cookie filtering, finite frame CSP, and listeners that expose no control
   routes. All capability state fails closed on orchestrator restart.

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
