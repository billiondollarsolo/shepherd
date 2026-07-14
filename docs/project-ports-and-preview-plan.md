# Project Ports and Preview implementation plan

**Status:** Implemented and validated for Shepherd 0.4.0
**Owner:** Shepherd
**Last updated:** 2026-07-14
**Scope:** Project-owned development-server discovery, forwarding, embedded Preview,
private no-DNS forwarding, and deployment controls

## Executive decision

Shepherd should model development servers as **Ports owned by a project**, not as a
browser attached to one agent session. An agent may start a server, but the useful
resource is the service listening on the project's node. It should remain available to
the project when the originating agent exits and should be usable by every agent working
in that project.

The product will expose two forwarding backends behind one Ports experience:

1. **Hostname Preview** — the preferred and most isolated mode. Every forwarded service
   receives a random hostname beneath a dedicated Preview DNS suffix. It is appropriate
   for public HTTPS, external reverse proxies, and private deployments with DNS.
2. **Private port pool** — the no-DNS mode. Shepherd allocates a bounded external port
   for each forwarded project service, such as `http://100.64.0.10:12001`. It is intended
   for a private Tailnet, LAN, or tightly firewalled host and requires an explicit
   insecure/private-mode acknowledgement.

Both modes carry HTTP, WebSocket, and HMR traffic through the existing authenticated
node transport. “Open here” uses the user's native browser in a sandboxed iframe; “Open
in browser” opens the same forwarded origin in a new tab. Shepherd will not restore the
retired server-side Chrome, CDP, or screenshot-streaming runtime.

The no-DNS mode is deliberately not presented as equivalent to hostname isolation.
Browser origins include a port, but cookies do not. Strict control-plane Origin checks,
reserved-cookie defenses, dedicated Preview-only listeners, and visible private-mode
warnings are release blockers for the port-pool backend.

## Goals

- Show the loopback web services that are actually running for a project.
- Let a user label, remember, start, stop, open, and inspect multiple services without
  manually constructing tunnels.
- Keep services project-scoped and node-aware across desktop and mobile.
- Preserve normal development-server behavior, including assets, routing, WebSockets,
  hot reload, downloads, and application cookies within the limits of each backend.
- Work without DNS on a private IP by assigning external ports automatically.
- Offer stronger hostname isolation whenever DNS is available.
- Explain deployment state and failure reasons in Settings instead of requiring log or
  Compose-file archaeology.
- Keep infrastructure changes explicit. The UI may validate and generate configuration,
  but it must not silently mutate Docker, Caddy, DNS, firewall, or host networking.
- Retain bounded memory, connection, byte, time, and port-allocation behavior.
- Make the security boundary testable and understandable.

## Non-goals for the first release

- Arbitrary public TCP forwarding, SSH forwarding, databases, or non-HTTP protocols.
- Starting or stopping the user's development server process.
- A remote graphical browser, CDP automation, pixels, or video streaming.
- Automatically creating DNS records or certificates.
- Runtime Docker-socket or Caddy-admin mutation.
- Stripping an upstream application's `X-Frame-Options` or CSP protections.
- Public sharing links, unauthenticated previews, team visibility, or RBAC.
- A desktop companion that binds true local `127.0.0.1:<port>` listeners. This remains a
  possible later option for VS Code-style local forwarding without DNS or exposed host
  ports.
- Perfect cookie isolation between multiple ports on the same hostname. Browsers do not
  provide that primitive; deployments requiring that isolation must use hostname mode.

## Product terminology

| Term           | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Port           | A detected or manually entered HTTP service on a project's node                                         |
| Saved service  | Durable project metadata such as label, target port, protocol, and user preference                      |
| Forward        | An active, expiring mapping from a browser-reachable origin to exactly one node loopback port           |
| Preview        | The browser experience that opens a forwarded Port, either inside Shepherd or in a new tab              |
| Hostname mode  | One isolated hostname per forward under a dedicated Preview domain                                      |
| Port-pool mode | One preconfigured, bounded external port per forward on the Shepherd hostname/IP                        |
| Detected       | A listener reported by agentd but not necessarily saved or forwarded                                    |
| Remembered     | A saved service definition; remembering does not silently expose it after a restart                     |
| Auto-forward   | An explicit per-project preference to start a remembered service when an authenticated user opens Ports |

User-facing copy should say **Ports** for the project feature and **Preview** for the
action. Internal compatibility-sensitive `flock-*` and `FLOCK_*` identifiers remain
until the separate deep-rename migration; this feature should not invent a partial
second environment-variable namespace.

## Desired user experience

### Project page

Each project gains a first-class **Ports** view at `/p/:projectId/ports`, reachable from
the project navigation, sidebar project menu, command palette, desktop UI, and mobile
menu.

The view contains:

- A compact list of detected and saved services.
- Service label, target port, protocol, node, detection source, process hint, forward
  status, public origin, and expiry.
- Primary actions: **Open here**, **Open in browser**, **Start forwarding**, and **Stop**.
- Secondary actions: rename, remember/forget, toggle auto-forward, copy URL, refresh,
  and view technical details.
- A manual **Forward a port** action for an older agentd, an ambiguous listener, or a
  server that discovery cannot inspect.
- Clear states for detecting, listening, unreachable, forwarding, expired, blocked by
  policy, agentd upgrade required for discovery, and pool exhausted.

The first successful manual forward should offer a useful default label inferred from
the port/process, while keeping the label editable. Common conventional labels may be
suggested (`Web`, `API`, `Storybook`, `Docs`) but never treated as authoritative.

### Embedded Preview

**Open here** displays the native page in Shepherd's center area with a small toolbar:

- Project, node, service label, and target port.
- Connection/expiry state.
- Reload, copy URL, open externally, and stop-forwarding actions.
- A visible private-mode badge when port-pool HTTP is active.

The iframe uses a restrictive sandbox, `referrerpolicy="no-referrer"`, and a narrow
Permissions Policy. It may allow scripts, forms, same-origin behavior within the
preview, downloads, modals, and user-initiated popups because common development apps
need them. It must not allow top-level navigation or control of the Shepherd window.

If an upstream app refuses framing with `X-Frame-Options` or CSP `frame-ancestors`,
Shepherd preserves that protection and shows a precise **Open in browser** fallback.
The product must not display a blank or endlessly loading pane with no explanation.

### Mobile

The Ports view is fully functional on a narrow viewport:

- Node/project context remains visible.
- Service rows become stacked cards without horizontal overflow.
- Create, edit, start, stop, and open actions are touch-sized.
- Embedded Preview occupies a dedicated full-screen route with a compact toolbar.
- Returning from Preview restores the Ports list and its scroll position.
- External opening is always available when iframe embedding or mobile viewport behavior
  is unsuitable.

### Multiple ports and projects

- Multiple services may be forwarded concurrently up to deployment and runtime caps.
- Two projects on the same node may refer to the same target port, but their saved
  definitions, capabilities, lifecycle, and audit records remain separate.
- Shepherd may reuse a lower-level node connection internally, but it must never merge
  project ownership or expose one project's metadata through another.
- Duplicate entries within one project and protocol are merged deterministically.
- Ending an agent does not revoke a project forward.
- Deleting/moving the project, removing the node, revoking the forward, expiry,
  disabling Preview, or orchestrator shutdown closes it immediately.
- A remembered service survives restart as metadata; an active capability and socket do
  not. Auto-forward is opt-in and activates only after authenticated project access,
  never blindly during server startup.

## Architecture

```text
Native browser / Shepherd iframe
              │
              │ hostname origin OR allocated private port
              ▼
      Preview-only gateway listener
              │
              │ exact project + node + target-port mapping
              ▼
          Node transport
      local dial or SSH/agentd stream
              │
              ▼
        127.0.0.1:<target>
       project development server
```

The forwarded request never becomes a general-purpose node proxy. The mapping fixes the
node, target address, target port, protocol, owner, expiry, and resource limits before a
browser request reaches the gateway.

### State ownership

| State                              | Owner                        | Durable | Notes                                                                    |
| ---------------------------------- | ---------------------------- | ------- | ------------------------------------------------------------------------ |
| Listening-port snapshot            | agentd/orchestrator cache    | No      | Bounded, expiring observation                                            |
| Saved project service              | PostgreSQL                   | Yes     | Label, port, protocol, preferences                                       |
| Active forward                     | orchestrator Preview service | No      | Reconciled away on restart                                               |
| Plaintext launch capability        | Browser once                 | No      | Fragment only; never logged or persisted                                 |
| Capability digest and cookie name  | orchestrator memory          | No      | Destroyed on revoke/expiry/restart                                       |
| Hostname or pool-slot allocation   | orchestrator allocator       | No      | Unique while active; released only after every connection closes         |
| Runtime kill switch/default policy | PostgreSQL                   | Yes     | Included in backup; constrained by deployment hard caps                  |
| Infrastructure configuration       | Environment/proxy/deployment | Yes     | Read-only in UI; changes are explicitly marked restart/redeploy required |

### Shared contracts

Replace the session-centric contract with strict, versioned project contracts. Proposed
types include:

```ts
type ProjectPort = {
  id: string;
  projectId: string;
  nodeId: string;
  targetHost: '127.0.0.1' | '::1';
  targetPort: number;
  protocol: 'http' | 'https';
  label: string;
  source: 'detected' | 'terminal_hint' | 'manual' | 'saved';
  process?: { pid?: number; name?: string };
  remembered: boolean;
  autoForward: boolean;
  status: 'detected' | 'forwarding' | 'unreachable' | 'expired' | 'stopped';
  forward: ProjectForward | null;
};

type ProjectForward = {
  id: string;
  backend: 'hostname' | 'port_pool';
  origin: string;
  publicPort?: number;
  createdAt: string;
  expiresAt: string;
  health: 'starting' | 'ready' | 'degraded';
};
```

All schemas must use shared Zod contracts and inferred TypeScript types. The response
never includes capability material except the one-time `launchUrl` returned by a start
or relaunch action. Process metadata is optional, length-bounded, and display-only.

Initial protocol scope is HTTP and HTTPS upstreams with WebSocket upgrade support. A
numeric port must remain within 1024–65535. Supporting privileged ports or arbitrary TCP
requires a separate security review and contract.

### Durable data

Add a `project_services` table with:

- UUID primary key.
- Foreign key to project with cascade cleanup.
- Node identity copied only when needed for integrity/reconciliation; the current
  project node remains authoritative.
- Target port and protocol.
- User label.
- Remembered and auto-forward preferences.
- Created/updated timestamps.
- Unique constraint on project, target port, and protocol.

Add a single-owner `preview_runtime_settings` record, or a strictly versioned equivalent,
for the runtime enable switch, default TTL, and allowed auto-forward policy. Deployment
hard caps always win over database preferences.

Do not persist launch tokens, cookie values, active public origins, live sockets, or a
claim that a forward survived restart. Audit events may record project/service IDs,
ports, backend, outcome, and reason code but never capability values or full request
URLs.

Saved service and runtime policy records must be included in encrypted vault backups and
restore validation. Active forwards intentionally restore as stopped.

### Agentd listener discovery

Add an additive authenticated capability named `listening_ports_v1`. It should not
require a control-protocol version bump because older daemons can continue to support
manual port entry.

Agentd returns a bounded snapshot of TCP listeners with:

- Loopback/wildcard bind address and port.
- PID and short process basename when the daemon's OS identity is allowed to inspect it.
- Session ID when the listener belongs to the known process tree of an agent session.
- Bounded working directory when readable.
- Snapshot time and a stable observation key.

Implementation rules:

- Read Linux `/proc/net/tcp`, `/proc/net/tcp6`, process file descriptors, and process
  ancestry directly. If a platform fallback uses `ss`, execute a fixed argument vector
  with no user-controlled shell input and parse bounded output.
- Return only listeners relevant to development workflows. Never return established
  connections, command arguments, environment variables, file contents, or socket
  payloads.
- Cap records, string lengths, scan time, and scan concurrency. A partial bounded result
  is preferable to blocking the control plane.
- Make missing OS permissions an explicit degraded-discovery state, not an empty healthy
  result.
- Keep discovery read-only and low privilege.

The orchestrator associates a listener to a project using this precedence:

1. The listener process belongs to a Shepherd session whose project is known.
2. Its readable working directory is the project's working directory or a descendant.
3. The listener remains node-level/unassigned and is shown only as a manual suggestion.

Ambiguous matches are never silently assigned. The user can explicitly attach an
unassigned port to a project.

Terminal URL detection may add a `terminal_hint` for `localhost`, `127.0.0.1`, or `[::1]`
URLs, but it is only a hint. It emits protocol and port, does not persist surrounding PTY
content, and must be confirmed against the authoritative listener snapshot before an
automatic start.

Use a 2–5 second refresh while the Ports view is visible and a 15–30 second bounded
background refresh only when needed. Expire stale observations and coalesce overlapping
requests. An old compatible agentd without `listening_ports_v1` receives a visible
manual-entry fallback and an “upgrade recommended for automatic discovery” explanation.

### Orchestrator service

Introduce a project Ports service that composes three sources without leaking their
lifecycle into UI components:

1. Agentd listener observations.
2. Durable saved service definitions.
3. Ephemeral active forwards.

Responsibilities include:

- Owner and project/node authorization.
- Deterministic merging and deduplication.
- Exact loopback reachability probe before allocation.
- Idempotent start/replace/stop operations.
- Capability issuance and revocation.
- Pool/hostname allocation and collision handling.
- Project/node lifecycle cleanup.
- Runtime policy enforcement and audit events.
- Shutdown draining and bounded connection tracking.

The existing node transport remains the only upstream dialing abstraction. It must dial
an exact numeric loopback port and must not accept a hostname, URL, arbitrary address, or
redirect target from the browser.

### HTTP API

Proposed authenticated routes:

| Method   | Route                                                        | Purpose                                       |
| -------- | ------------------------------------------------------------ | --------------------------------------------- |
| `GET`    | `/api/projects/:projectId/ports`                             | Composite detected/saved/active state         |
| `POST`   | `/api/projects/:projectId/ports`                             | Save or manually define a project service     |
| `PATCH`  | `/api/projects/:projectId/ports/:serviceId`                  | Rename or change safe preferences             |
| `DELETE` | `/api/projects/:projectId/ports/:serviceId`                  | Forget definition and revoke its forward      |
| `POST`   | `/api/projects/:projectId/ports/refresh`                     | Request a bounded discovery refresh           |
| `POST`   | `/api/projects/:projectId/ports/:serviceId/forward`          | Probe, allocate, and issue one launch URL     |
| `DELETE` | `/api/projects/:projectId/ports/:serviceId/forward`          | Revoke and close active connections           |
| `POST`   | `/api/projects/:projectId/ports/:serviceId/forward/relaunch` | Rotate browser capability without remapping   |
| `GET`    | `/api/settings/deployment-preview`                           | Effective config, health, limits, and reasons |
| `PATCH`  | `/api/settings/deployment-preview`                           | Runtime-safe settings only                    |
| `POST`   | `/api/settings/deployment-preview/test`                      | DNS/routing/pool/gateway validation           |

Start and stop operations require idempotency keys or deterministic replacement
semantics so retries cannot leak allocations. Every mutation validates the current
project-to-node relationship again. Error responses use stable reason codes such as
`preview_disabled`, `listener_missing`, `agentd_capability_missing`, `pool_exhausted`,
`origin_mismatch`, and `restart_required`.

The current session Preview routes remain only during migration. New UI must use project
routes. After parity and migration tests, delete the old routes, contracts, service
branches, session-termination coupling, and session Preview tab instead of retaining a
permanent compatibility layer.

## Forwarding backends

### Hostname mode

Hostname mode remains the recommended backend:

- Generate an unguessable per-forward label beneath `FLOCK_PREVIEW_DOMAIN`.
- Route through one dedicated Preview gateway listener.
- Keep the existing fragment-to-cookie capability exchange.
- Use Secure, HttpOnly, host-only cookies under HTTPS.
- Support HTTP, WebSocket upgrades, HMR, and explicit upstream HTTPS.
- Allow only active hostnames through the Caddy on-demand-TLS authorization endpoint.
- Revoke the hostname and close connections on stop, expiry, project/node deletion,
  runtime disable, or shutdown.

The hostname must remain different from the control-plane hostname. A wildcard or
on-demand certificate and DNS suffix are infrastructure prerequisites, reported clearly
in Settings.

### Private port-pool mode

Port-pool mode provides no-DNS forwarding for a private Tailnet/LAN deployment:

```text
Shepherd             http://100.64.0.10:11010
Project Web :3000  → http://100.64.0.10:12001
Project API :8080  → http://100.64.0.10:12002
Storybook :6006    → http://100.64.0.10:12003
```

Architecture requirements:

- Configure a bounded contiguous range, initially no larger than 64 slots, using a
  deployment variable such as `FLOCK_PREVIEW_PORT_RANGE=12000-12031`.
- Pre-publish that exact range in the explicit private Compose profile. Do not mount the
  Docker socket or mutate port publication at runtime.
- Run Preview-only HTTP listeners for the configured slots. These listeners must not
  serve the Shepherd UI, login, API, health, hooks, or WebSockets.
- Derive the slot from the accepted listener, never from an untrusted forwarding header.
- Allocate atomically, randomize the first free-slot search, reserve before probing
  becomes externally reachable, and release only after all active connections close.
- Reconcile every slot on startup/shutdown and prove that stale mappings cannot survive
  process restart.
- Issue a unique random capability-cookie name per mapping so a cookie from a previous
  occupant of the same slot cannot authorize the next occupant.
- Continue putting the plaintext capability in a fragment and keeping only its digest in
  memory.
- Use the effective public host from the validated Shepherd public URL; never trust the
  request `Host` header to construct launch URLs.
- Bind/publish only on the addresses explicitly chosen by the operator. Documentation
  and diagnostics must show the firewall/Tailnet exposure.

The first release supports direct private HTTP pool listeners after
`FLOCK_ALLOW_INSECURE_HTTP=1` and explicit port-pool selection. HTTPS port-pool support
may follow through generated Caddy/external-proxy listeners using the same hostname
certificate on every configured port. Public internet deployment continues to require
hostname mode until the HTTPS pool topology and its operational burden are fully tested.

Phase 0 must validate Docker Compose range publication, listener ownership, restart
behavior, and CSP generation before the final listener topology is frozen. The preferred
implementation is a reusable Preview gateway server bound once per configured internal
slot in the orchestrator container and published only by the private profile. If that
cannot preserve container and shutdown isolation cleanly, use a small privilege-separated
Preview edge process. Dynamic Caddy-admin or Docker-socket access is not an acceptable
fallback.

## Browser and control-plane security

### Mandatory security gate for port-pool mode

Same hostname with different ports is a different JavaScript origin but the same cookie
host/site. Before port-pool mode can ship:

- Enforce exact configured control-plane `Origin` on every unsafe browser method
  (`POST`, `PUT`, `PATCH`, and `DELETE`). Missing or mismatched Origin fails closed.
- Keep bearer-only hook callbacks and deliberate non-browser endpoints on explicitly
  separate policies; do not add a broad bypass.
- Validate WebSocket Origin separately and exactly.
- Reject ambiguous duplicate Shepherd authentication cookies.
- Filter every reserved Shepherd login, setup, CSRF, and Preview cookie name from requests
  before forwarding upstream.
- Strip reserved `Set-Cookie` response headers, including case/attribute variations.
- Strip `Authorization`, `Proxy-Authorization`, Shepherd credentials, forwarded client
  identity, `Forwarded`, `X-Forwarded-*`, and `Referer` before upstream.
- Do not reflect upstream CORS headers onto the control plane or expose the control-plane
  API on a Preview listener.
- Deny service-worker registration responses and prevent a Preview origin from controlling
  the Shepherd origin.
- Apply no-referrer and opener isolation headers.
- Make the private-mode warning state persistent and visible.

Strict Origin/CSRF protection prevents Preview JavaScript from using the browser's
same-host cookies to mutate Shepherd. CORS alone is insufficient because a cross-origin
simple request can still cause a side effect even when its response cannot be read.

Port-pool mode still cannot prevent unrelated development applications on different
ports from sharing host-scoped application cookies. The gateway can remove `Domain`
attributes and block reserved names, but JavaScript-created cookies are also host-scoped.
This limitation must appear in the UI and deployment documentation. Use hostname mode
for untrusted applications or strong inter-preview isolation.

### Preview gateway hardening

Both backends must retain or add:

- Exact owner/project/node/port mapping.
- Loopback-only upstream dialing and numeric-port validation.
- High-entropy one-time launch capability, digest-only storage, expiry, and rotation.
- HttpOnly authorization cookie with Secure where TLS is active.
- Per-forward connection, request-byte, response-byte, header, and duration limits.
- Global forward and connection caps.
- HTTP request-smuggling defenses and strict hop-by-hop header handling.
- WebSocket upgrade and Origin tests.
- Upstream connect timeout and cancellation propagation.
- Immediate revoke that closes HTTP and WebSocket work.
- Slot/hostname reuse tests that prove old credentials fail.
- No token, cookie, PTY content, query string, or sensitive response body in logs/audit.

The target remains loopback even if a process listens on a wildcard address. Redirects
returned by the user's app stay browser responses; the gateway never follows a redirect
and turns it into server-side request forgery.

### Main-page CSP and iframe policy

Update the Shepherd CSP per deployment topology:

- Hostname mode: permit frames only from the dedicated Preview suffix and scheme.
- Port-pool mode: generate the finite set of allowed Preview origins from the validated
  public hostname and configured slot range. Avoid an unrestricted `*` or arbitrary
  internet frame source.
- External proxy mode: generate a copyable exact CSP fragment and report when the
  effective response header does not permit embedding.
- If a safe frame source cannot be established, disable **Open here** and retain **Open
  in browser**.

Preserve upstream `X-Frame-Options` and `frame-ancestors`. Add a gateway-observed reason
code so the UI can distinguish upstream refusal from network failure without reading the
cross-origin iframe DOM.

## Settings: Deployment & Preview

Add a focused section under Settings with these groups.

### Current state

- Deployment mode and public Shepherd URL.
- Effective Preview backend: disabled, hostname, or private port pool.
- Preview domain or public host and allocated port range.
- Gateway/listener health.
- Runtime enabled/disabled state.
- Effective TTL, global forward cap, per-forward connection cap, and byte/time limits.
- Active forwards and pool utilization without exposing capability values.
- Agentd discovery support by node.

### Explanations and actions

- A precise reason when Preview or embedding is disabled.
- A runtime kill switch that immediately revokes active forwards without restart.
- Runtime-editable default TTL and auto-forward policy, bounded by deployment hard caps.
- DNS validation for hostname mode.
- Port binding, exposure, and end-to-end routing test for pool mode.
- A test that creates an internal synthetic upstream, proves HTTP and WebSocket routing,
  and cleans up even on failure.
- Copyable configuration for bundled HTTPS, external TLS proxy, and private Tailnet/LAN
  HTTP.
- Exact firewall ports and CSP/proxy snippets for the effective configuration.

### Restart boundaries

DNS, certificates, public URL, bind addresses, proxy trust, Preview backend, port range,
and container port publication are infrastructure values. Show them as read-only with a
**Restart/redeploy required** label and generated instructions. Shepherd must not claim
that a database/UI change can create DNS, modify a firewall, or republish container
ports.

The runtime kill switch, default TTL inside the deployment maximum, auto-forward policy,
and saved project services can change without restart.

## Phased implementation

### Phase 0 — Architecture and security spike

#### Tasks

- Build a minimal bounded pool with two Preview-only listeners and one synthetic upstream.
- Validate Compose range publication on Docker Engine and rootless Docker where supported.
- Verify accepted-socket local-port identification cannot be spoofed by headers.
- Validate Caddy/external-proxy options for a future TLS pool without enabling admin APIs.
- Prove finite CSP frame-source generation for bundled, private, and external modes.
- Test iOS Safari and desktop Chromium/Firefox iframe behavior, WebSockets, HMR, cookies,
  downloads, popups, viewport changes, and upstream frame refusal.
- Write an ADR selecting the final pool listener topology and recording cookie/site limits.
- Threat-model the chosen topology before product code depends on it.

#### Reasoning

Port publication, cookie scoping, CSP, and container ownership determine the security
boundary. A small measured spike avoids repeating the earlier mistake of optimizing the
visible browser surface before validating the complete browser/runtime lifecycle.

#### Definition of done

- The ADR selects one topology without Docker socket or dynamic proxy mutation.
- A real private IP can open two simultaneous mapped services with no DNS.
- Old slot credentials fail after revoke and reuse.
- Known browser and proxy limitations are recorded with a deliberate fallback.

### Phase 1 — Security prerequisites

#### Tasks

- Inventory every unsafe HTTP route and classify its Origin/auth policy.
- Enforce exact control-plane Origin globally with narrow, tested public/bearer exceptions.
- Reject duplicate reserved auth cookies and harden reserved cookie filtering.
- Add regression tests proving Preview-origin requests cannot mutate control-plane state.
- Centralize gateway header/cookie sanitation for both backends.
- Add stable security reason codes and redacted audit events.

#### Reasoning

Port-pool Preview code shares the control-plane cookie host. These defenses must exist
before any pool listener is reachable.

#### Definition of done

- Every unsafe route is covered by an explicit policy test.
- Cross-port form, fetch, and WebSocket attacks fail.
- Login, setup, hooks, terminal WebSockets, and existing hostname Preview continue to work.
- Security tests fail if a new unsafe route omits Origin handling.

### Phase 2 — Project service domain and persistence

#### Tasks

- Add shared `ProjectPort`, `ProjectForward`, settings, request, response, and error schemas.
- Add and test `project_services` and runtime-settings migrations.
- Implement repositories and a pure merge/state reducer for detected, saved, and active
  service state.
- Include durable settings/services in backup and isolated restore verification.
- Add audit event types for save, forget, start, stop, expire, runtime disable, and test.

#### Reasoning

A coherent project domain prevents session, discovery, database, allocator, and UI state
from becoming parallel sources of truth.

#### Definition of done

- Duplicate project/port/protocol records are impossible.
- Active capabilities are absent from PostgreSQL and backups.
- Restore returns saved services as stopped and requires a fresh capability.
- Shared contracts reject unknown fields and invalid lifecycle states.

### Phase 3 — Agentd discovery

#### Tasks

- Implement `listening_ports_v1` in the shared agentd protocol package and capability list.
- Build bounded Linux listener/process/session association.
- Add authenticated client support and orchestrator caching/coalescing.
- Implement project association and explicit ambiguous/unassigned results.
- Expose discovery health and compatibility state in node diagnostics.
- Retain manual entry for compatible older daemons.

#### Reasoning

The node daemon has the correct local visibility and authenticated identity. Shelling out
from random orchestrator routes would duplicate parsing and weaken the boundary.

#### Definition of done

- A server started by an agent appears under the correct project within the target refresh
  window.
- Ambiguous and permission-denied cases are explicit.
- Large `/proc` inputs remain bounded and cancellable.
- An old daemon stays usable through manual entry and is never falsely reported as empty.

### Phase 4 — Project Ports API and lifecycle

#### Tasks

- Implement the composite Ports service and authenticated routes.
- Probe exact node loopback listeners through the transport abstraction.
- Decouple forward lifetime from session termination.
- Revoke on project/node deletion or reassignment, runtime disable, expiry, and shutdown.
- Add idempotency and concurrency control around start/replace/stop.
- Add node-local and SSH/agentd transport integration tests.

#### Reasoning

This establishes the correct ownership model while reusing the proven exact-port tunnel.

#### Definition of done

- A project can save and forward multiple ports.
- Ending the originating agent does not stop the forward.
- Moving/deleting the owning resource does stop it.
- Concurrent starts cannot create duplicate forwards or leak allocations.

### Phase 5 — Desktop and mobile Ports UI

#### Tasks

- Add the project route, navigation, sidebar action, and command-palette actions.
- Implement service list/cards, statuses, actions, manual entry, labels, remember, and
  optional auto-forward.
- Build the embedded Preview toolbar and frame-refusal fallback.
- Add responsive mobile list and full-screen Preview route.
- Preserve focus, scroll position, keyboard navigation, and touch target sizes.
- Add accessible live status and error announcements.

#### Reasoning

Users should reason about node → project → service, not remember which agent happened to
launch a server.

#### Definition of done

- Every Ports action works on desktop and iOS-sized mobile viewports without overflow.
- Multiple services can be opened, stopped, and relaunched independently.
- An upstream frame refusal produces a usable new-tab action.
- Refresh reconstructs saved/detected state without pretending an old capability is live.

### Phase 6 — Private no-DNS port pool

#### Tasks

- Add strict range parsing, maximum slot count, collision-safe allocator, and listener
  lifecycle.
- Add the explicit private Compose port publication and environment examples.
- Generate launch origins from validated deployment configuration.
- Add unique per-mapping cookie names and slot-reuse defenses.
- Generate/validate the finite iframe CSP source set.
- Expose pool health, utilization, and firewall guidance in diagnostics.
- Refuse startup on overlapping, invalid, privileged, or unsafe ranges.

#### Reasoning

This supplies the intuitive “same private IP, automatically assigned ports” experience
without requiring DNS or a local desktop helper.

#### Definition of done

- A fresh private/Tailnet deployment forwards multiple services through one configured
  range with no DNS.
- Only the configured ports are published and every published port is Preview-only.
- Pool exhaustion is clean, visible, and recoverable.
- Restart, revoke, expiry, slot reuse, CSRF, and cookie-isolation regression tests pass.

### Phase 7 — Deployment & Preview settings

#### Tasks

- Add effective-config/health contracts and authenticated settings routes.
- Implement runtime kill switch and bounded runtime preferences.
- Add DNS, CSP, pool exposure, HTTP, and WebSocket self-tests with guaranteed cleanup.
- Build the Settings section with generated Compose/proxy/firewall snippets.
- Mark all infrastructure changes as restart/redeploy required.
- Add redaction and copy-safe diagnostics.

#### Reasoning

Deployment flexibility is useful only when the operator can see what is active, why it
is disabled, and which changes belong outside the application.

#### Definition of done

- The Settings page accurately describes every supported mode.
- The kill switch revokes all active forwards immediately.
- Tests identify DNS, CSP, listener, proxy, upstream, and capability failures separately.
- No UI control implies it changed infrastructure that it cannot own.

### Phase 8 — Session Preview migration and dead-code removal

#### Tasks

- Change the session Preview shortcut to open the owning project's Ports view.
- Migrate any useful session-entered port to a project service when unambiguous.
- Remove session-scoped endpoints, contracts, UI state, termination hooks, tests, and copy.
- Update architecture, deployment, threat-model, operations, README, and roadmap docs.
- Run dead-code and duplicate-code tooling after removal.

#### Reasoning

Keeping two ownership models would create contradictory lifecycle behavior and permanent
maintenance debt. This is greenfield product work; parity should end in deletion, not a
hidden compatibility layer.

#### Definition of done

- There is one user-facing Ports/Preview model.
- Session termination contains no Preview cleanup path.
- Search and dead-code checks find no obsolete session Preview or browser/screencast code.
- Existing hostname deployments retain functionality through the project model.

### Phase 9 — Hardening, performance, and release

#### Tasks

- Run browser, transport, deployment, adversarial, soak, and restart test matrices.
- Benchmark discovery scans, gateway throughput, WebSocket longevity, and pool churn.
- Verify bounds under slow clients, large responses, connection storms, and node loss.
- Update release checks, sample environments, Compose validation, upgrade notes, and GHCR
  image smoke tests.
- Document the agentd capability as recommended first; raise the minimum only in a later
  release after the compatibility support window.
- Conduct a focused security review before enabling pool mode outside development builds.

#### Reasoning

Preview is an authenticated cross-network proxy for untrusted development content. It
needs release-level validation, not only component tests.

#### Definition of done

- All acceptance matrices below pass on a clean deployment.
- Resource use returns to baseline after revoke, restart, and node loss.
- Release docs state which backend is appropriate for each deployment.
- No critical/high vulnerability or unresolved security finding affects the path.

## Configuration model

The exact variable names are finalized in Phase 0. The intended effective model is:

| Setting                        | Example                        | Runtime? | Purpose                                             |
| ------------------------------ | ------------------------------ | -------- | --------------------------------------------------- |
| Preview backend                | `hostname` / `port-pool`       | No       | Select isolated DNS or private no-DNS routing       |
| `FLOCK_PREVIEW_DOMAIN`         | `preview.example.com`          | No       | Dedicated hostname suffix                           |
| `FLOCK_PREVIEW_PORT_RANGE`     | `12000-12031`                  | No       | Bounded private external/internal slot range        |
| Preview bind address           | container/private interface    | No       | Explicit listener exposure                          |
| Preview TTL hard maximum       | `8h`                           | No       | Deployment safety bound                             |
| Default TTL                    | `2h`                           | Yes      | Owner preference within hard maximum                |
| Maximum concurrent forwards    | `16`                           | No       | Deployment hard cap                                 |
| Maximum connections/bytes/time | bounded values                 | No       | Gateway resource caps                               |
| Runtime enabled                | `true`                         | Yes      | Immediate kill switch                               |
| Automatic forwarding policy    | `off` / `remembered-on-access` | Yes      | Never silently broadens exposure at process startup |

Invalid infrastructure configuration fails closed with an actionable readiness reason.
An empty or unspecified mode does not silently publish a port range.

## Deployment support matrix

| Deployment                                 | Initial backend  | Open here | Security position                                                     |
| ------------------------------------------ | ---------------- | --------- | --------------------------------------------------------------------- |
| Bundled public HTTPS + Preview DNS         | Hostname         | Yes       | Recommended public deployment                                         |
| External TLS proxy + Preview DNS           | Hostname         | Yes       | Supported when proxy, CSP, WebSocket, and certificate checks pass     |
| Private Tailnet/LAN HTTP + no DNS          | Port pool        | Yes       | Explicit private-mode risk acknowledgement; trusted network/apps only |
| Private Tailnet/LAN HTTP + Preview DNS     | Hostname         | Yes       | Better isolation even without public internet                         |
| Direct public IP over HTTP                 | Disabled         | No        | Not supported as a secure deployment                                  |
| Public HTTPS port pool without Preview DNS | Later validation | Fallback  | Requires generated TLS listeners, CSP, and operational testing        |
| Desktop companion localhost forwarding     | Future           | Native    | Optional future mode; outside this plan's first implementation        |

Operators may choose a less restrictive private deployment, but Shepherd must label it
accurately and never call unencrypted public exposure secure.

## Testing and validation

### Unit tests

- Zod contracts and unknown-field rejection.
- Port/range parsing, reserved ranges, maximum size, and overlaps.
- Allocator concurrency, exhaustion, fairness, revoke, expiry, and reuse.
- Project merge/deduplication and lifecycle reducer.
- Origin policy for every method/surface.
- Cookie parsing, duplicates, reserved-name filtering, and `Set-Cookie` variations.
- Hop-by-hop/forwarded header sanitation.
- Capability creation, hashing, exchange, rotation, expiry, and constant-time validation.
- `/proc` IPv4/IPv6 listener, inode, PID, ancestry, cwd, permissions, truncation, and
  malformed fixture parsing.
- Project association scoring and ambiguous results.
- Settings hard-cap/runtime preference resolution.

### Agentd and protocol tests

- Authenticated capability negotiation with current and older compatible fixtures.
- Bounded listener snapshot under large process/socket tables.
- Session-child and cwd project association inputs.
- Permission denied, vanished process, PID reuse, and concurrent process exit.
- Cancellation, timeout, record cap, and malformed OS data.
- Manual fallback when `listening_ports_v1` is absent.

### Orchestrator integration tests

- Local and SSH node exact-port dial.
- HTTP methods, streaming, large bounded bodies, redirects, compression, and errors.
- WebSocket echo, HMR-style reconnect, revoke, expiry, and node disconnect.
- Project deletion/move, node removal, shutdown, and runtime kill switch.
- Duplicate/concurrent start and stop retries.
- Two projects using the same node target port without ownership crossover.
- Database migration, backup, isolated restore, and stopped-state reconciliation.
- Hostname authorization and pool-slot allocation.
- Self-test cleanup after success, timeout, and cancellation.

### Browser and UI tests

- Desktop Chromium, Firefox, and WebKit; iPhone-sized WebKit and Android-sized Chromium.
- Detection, manual entry, save, rename, remember, auto-forward, start, open, stop, and
  expiry.
- Multiple simultaneous ports and projects.
- Embedded client-side routing, assets, fetch, WebSocket/HMR, download, popup, and reload.
- Upstream XFO/CSP refusal with immediate external-open fallback.
- Mobile orientation, browser chrome resize, safe areas, no horizontal overflow, touch
  targets, scroll restoration, and back navigation.
- Refresh/reconnect does not revive stale capabilities or duplicate rows.
- Screen reader labels, focus order, keyboard operation, and live status.
- Command palette navigation and project/sidebar context.

### Adversarial security tests

- Preview JavaScript cannot read control-plane responses or perform state changes.
- Cross-port forms, `fetch`, images, scripts, and WebSockets cannot bypass Origin policy.
- A Preview receives no Shepherd auth/setup/hook/capability cookie or authorization header
  upstream.
- An upstream cannot set reserved Shepherd cookies through HTTP headers.
- Duplicate-cookie attacks fail closed.
- A capability for one project, hostname, port, slot, or expired allocation cannot access
  another.
- Slot and hostname reuse reject every old URL/cookie.
- User-controlled `Host`, forwarding headers, absolute-form requests, upgrade headers,
  redirects, and malformed lengths cannot change the upstream target.
- The gateway cannot dial non-loopback, privileged, unselected, or another node's port.
- Service workers, opener control, top navigation, referrer leakage, and iframe privilege
  escalation are blocked.
- Pool exhaustion and connection floods remain bounded and do not impair login/API health.
- Tokens and cookies are absent from logs, audit, diagnostics, errors, and support bundles.

### Deployment tests

- `docker compose config --quiet` for bundled TLS, external proxy, private HTTP, and dev.
- Only intended host ports are published in every profile.
- Caddy validation and effective response-header inspection.
- Clean private IP deployment with no DNS and at least two simultaneous pool forwards.
- Clean hostname deployment with HTTP, HTTPS, WebSocket, and certificate renewal paths.
- Firewall-denied and DNS-misconfigured states produce correct diagnostics.
- Container restart, full stack restart, upgrade, rollback, and vault restore.
- No Docker socket or proxy admin surface is introduced.

### Performance and soak tests

- Repeated listener discovery on a busy node without agent latency regression.
- Maximum concurrent forwards and connections for at least eight hours.
- Slow request/response consumers, half-open WebSockets, node loss, and reconnect churn.
- Repeated allocate/revoke cycles with stable file-descriptor, goroutine/handle, heap, and
  event-listener counts.
- Large but allowed HMR bundles and response streaming within configured memory bounds.

## Observability and diagnostics

Expose bounded, redacted data:

- Backend, enabled state, disable reason, listener health, and pool utilization.
- Counts of detected/saved/active services and current connections.
- Allocation, probe, connection, expiry, and revoke outcomes by reason code.
- Discovery capability/health and snapshot age per node.
- Configuration mismatches for public URL, DNS, CSP, range publication, and proxy routing.
- Audit events for user actions and runtime policy changes.

Never expose launch fragments, cookie names/values, token digests, application payloads,
full PTY lines, query strings, request bodies, SSH credentials, or environment variables.
Every in-memory metric label must have bounded cardinality; project, session, token, and
raw hostname IDs do not belong in process-wide metric labels.

## Failure behavior

- **Listener disappears:** keep saved metadata, mark unreachable, close active upstream
  work, and allow retry when it returns.
- **Node disconnects:** mark degraded, fail new requests quickly, retain allocation for a
  short bounded grace period if configured, then revoke.
- **Orchestrator restarts:** all active forwards stop; remembered services remain stopped.
- **Pool exhausts:** no eviction of an active service; return a clear capacity error.
- **DNS/TLS/CSP fails:** hostname forwarding stays disabled or external-open-only with an
  exact reason.
- **Upstream rejects iframe:** preserve response policy and offer new-tab opening.
- **Agentd is old:** manual forward remains available; discovery shows upgrade recommended.
- **Runtime kill switch is used:** immediately reject creation, revoke capabilities, close
  connections, release slots, and record one audit event per affected forward or a bounded
  aggregate.
- **Configuration is unsafe:** fail closed at startup/readiness; never silently downgrade
  public HTTPS to HTTP or hostname mode to a published pool.

## Rollout and compatibility

1. Ship strict control-plane Origin enforcement independently.
2. Add project contracts/persistence and agentd discovery as additive capabilities.
3. Add project Ports using the existing hostname gateway.
4. Validate hostname parity before enabling private port-pool mode.
5. Keep session Preview only long enough to migrate the UI and tests.
6. Delete session ownership and dead code in the same release that makes project Ports the
   only path.
7. Introduce `listening_ports_v1` as optional/recommended. Manual entry preserves support
   for the oldest compatible daemon.
8. Raise the daemon compatibility floor only through the documented support policy and
   release notes after automatic discovery is considered mandatory.

Database migrations follow expand/migrate/contract discipline through the supported
rollback window. Because active mappings are intentionally ephemeral, rollback never
needs to translate a live capability.

## Documentation deliverables

- README feature and deployment-scenario summaries.
- Deployment guide for hostname, external proxy, private DNS, and no-DNS port-pool modes.
- Threat-model update covering same-host/different-port cookie and CSRF boundaries.
- Architecture/state-ownership update for project services and agentd discovery.
- Agentd protocol/capability documentation.
- Settings and troubleshooting guide with generated-config examples.
- Backup/restore behavior for saved services and runtime policy.
- Release notes stating supported backend, agentd capability, migration, and security
  limitations.
- ADR for the selected port-pool listener/CSP topology.

## Overall definition of done

This initiative is complete when:

- A user can open a project, see its real node-local development servers, and forward
  several of them without knowing SSH tunnel syntax.
- The service remains project-owned when agents start or stop.
- A private Tailnet/LAN user can use an automatically allocated bounded port range with no
  DNS, while a public/TLS user can use the stronger hostname-isolated mode.
- Embedded Preview is crisp native browser rendering, responsive on desktop/mobile, and
  has a reliable external fallback.
- Settings accurately explains mode, URL/domain/range, health, limits, active mappings,
  failure reasons, runtime controls, and restart boundaries.
- Control-plane Origin, cookie, header, capability, iframe, service-worker, SSRF, resource,
  and lifecycle defenses pass adversarial tests.
- Active mappings and secrets never enter PostgreSQL, logs, backups, diagnostics, or
  support bundles.
- Every collection, listener, connection, scan, request, response, and timer is bounded
  and released on revoke, expiry, disconnect, shutdown, and restart.
- Old session Preview and server-side browser code are absent, dead-code/duplicate checks
  are clean, all deployment profiles validate, and the full release gate passes.
