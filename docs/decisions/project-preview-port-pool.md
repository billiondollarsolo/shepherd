# Decision: Project-owned Ports and a fixed private Preview pool

Status: Accepted
Date: 2026-07-14

## Context

Developers need to open web servers started on Shepherd nodes without configuring an SSH
tunnel for every service. The retired session browser attached Preview to one agent and
the retired Chrome/CDP runtime streamed pixels instead of preserving normal browser
behavior. Neither model matches the useful resource: a service on a project's node.

Public HTTPS deployments can isolate each service with a random hostname under a
dedicated Preview suffix. A direct Tailnet IP has no wildcard DNS, but a single forwarded
port is insufficient when a project runs a web app, API, docs, and HMR endpoints.

Dynamic Docker publication or Caddy admin mutation would require high-value control
surfaces. Same-host ports also share the browser cookie host even though they are
different JavaScript origins.

## Decision

1. A saved development service belongs to a project. Agent sessions may help discover a
   listener but do not own its lifecycle.
2. Hostname Preview remains the preferred backend. Every active forward receives a
   random hostname and an expiring capability.
3. The no-DNS private backend uses one contiguous, deployment-configured range of at
   most 64 unprivileged ports. Compose pre-publishes that exact range; the orchestrator
   binds one Preview-only server per slot. No service receives the Docker socket and no
   runtime proxy API is introduced.
4. The accepted listener's local port selects the mapping. `Host`, `Forwarded`, and
   `X-Forwarded-*` cannot select a node or upstream.
5. Each mapping fixes the owner, project, node, numeric loopback address, port, protocol,
   expiry, and resource limits before it becomes reachable.
6. A random launch capability travels only in a URL fragment, is stored only as a digest,
   and can authorize once. The resulting HttpOnly cookie has a unique random name per
   mapping. Relaunch rotates both and closes existing connections without reallocating
   the origin.
7. Pool mode is available only in explicitly acknowledged private HTTP mode for this
   release. Strict unsafe-method Origin checks, duplicate auth-cookie rejection,
   reserved-cookie filtering, and Preview-only listeners are prerequisites.
8. Embedded Preview is enabled only when the control-plane CSP contains the complete,
   finite source set. Otherwise the native new-tab action remains available.
9. Upstream framing protections are preserved. Shepherd records an observed refusal and
   presents an external-open fallback rather than stripping CSP or X-Frame-Options.

## Listener lifecycle

- The pool allocator randomizes its first free-slot search and never evicts an active
  mapping.
- A start retry replaces capability material in place; it cannot leak a second slot.
- Revoke, expiry, project/node deletion, runtime disable, or shutdown removes routing and
  destroys HTTP/WebSocket work before the event loop can reuse the slot.
- Active mappings are memory-only. A restart begins with every slot unassigned; durable
  project service labels return as stopped.
- The live routing test connects directly to the bound listeners and proves that every
  unallocated pool port rejects content. Component tests cover HTTP/WebSocket proxying,
  header/cookie sanitation, capability replay, revoke, and old-slot credential rejection.

## Browser limitation

Ports are different origins but cookies are scoped to a host, not a port. Shepherd can
protect its reserved cookies and use a distinct random capability-cookie name for every
mapping, but it cannot isolate arbitrary JavaScript-created application cookies between
two apps on the same IP. Operators must use hostname mode for mutually untrusted apps.
The UI and deployment guide keep this warning visible.

## Consequences

- Private operators publish a finite range and restrict it with their host firewall and
  Tailnet/LAN policy.
- Infrastructure values remain environment/proxy owned and require redeploy. The UI
  reports and generates configuration but never claims to mutate DNS, CSP, Docker, or a
  firewall.
- Upstream HTTP, HTTPS, WebSocket, and HMR retain native browser rendering. There is no
  server-side Chrome, CDP, screenshot, or video path.
- Automatic discovery is additive through `listening_ports_v1`; older compatible node
  daemons retain manual entry.

## Rejected alternatives

- **Dynamic Docker port publication:** requires Docker control and complicates cleanup.
- **Runtime Caddy admin changes:** creates another privileged mutable control plane.
- **One shared path proxy on the Shepherd origin:** exposes untrusted apps beneath the
  control-plane origin and breaks root paths, assets, cookies, and service workers.
- **One fixed forwarded port:** cannot support normal multi-service development.
- **Server-side browser streaming:** lower fidelity, higher resource use, and a broader
  browser-runtime attack surface.
- **Wildcard/any-port frame CSP:** grants more embedding authority than the configured
  pool and hides deployment mistakes.

## Verification

- `docker compose config --quiet` succeeds for the private override and publishes only
  the chosen control port plus the exact Preview range.
- Unit and integration tests cover invalid/overlapping ranges, pool exhaustion, replay,
  cookie/header attacks, WebSocket revoke, slot reuse, and control-route absence.
- Chromium, Firefox, and WebKit validation covers embedded/external opening, HMR,
  downloads, viewport changes, and upstream frame refusal before public release.

## Revisit when

- HTTPS port-pool listeners are required without Preview DNS;
- a desktop companion can bind true client-local ports; or
- Shepherd supports mutually untrusted human users or public share links.
