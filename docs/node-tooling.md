# Node tooling and Docker

Shepherd inventories the coding tools and Docker capability on every node. Detection is
automatic and read-only. Installation, upgrades, authentication, and Docker access are
separate decisions so adding a node never silently mutates it or grants privilege.

## Supported coding tools

| Tool         | Integration | Managed latest install | What Shepherd provides                                                                                                      |
| ------------ | ----------- | :--------------------: | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | First-class |          Yes           | Native PTY (Terminal) or the `claude-stream` structured Chat transport; hooks/transcript status, chat, telemetry, and plans |
| Codex        | First-class |          Yes           | Native PTY (Terminal) or the `codex-app-server` structured Chat transport; transcript status, chat, telemetry, and plans    |
| OpenCode     | First-class |          Yes           | Native PTY plus plugin status, chat, telemetry, and plans                                                                   |
| Antigravity  | First-class |          Yes           | Native PTY plus transcript-derived status and chat (Google's `agy`; successor to the Gemini CLI)                            |
| Gemini CLI   | First-class |          Yes           | Native PTY plus transcript/hook status and permissions (ACP support is dormant; the Gemini CLI is being retired)            |
| Grok Build   | First-class |          Yes           | Native PTY plus the lifecycle hooks Grok exposes                                                                            |
| Aider        | Terminal    |          Yes           | Native PTY, process supervision, reconnect, scrollback, and activity state                                                  |
| Cursor Agent | Terminal    |          Yes           | Native PTY, process supervision, reconnect, scrollback, and activity state                                                  |
| Amp          | Terminal    |          Yes           | Native PTY, process supervision, reconnect, scrollback, and activity state                                                  |

“Terminal” is a real supported integration, not a compatibility claim about structured
events the CLI does not expose. Terminal integrations do not currently provide
Shepherd-native chat, token/model/context, plan, or attention telemetry. Terminal and
Dev sessions need no external coding tool and are intentionally absent from this list.

Shepherd uses each vendor's current official installer and verifies the resulting
executable. This is a latest-channel convenience, not a version lock. Operators who need
a specific version can install and pin it themselves; Shepherd will detect it without
replacing it until **Upgrade** is explicitly confirmed.

Provider authentication is never provisioned by Shepherd. Launch the installed tool and
complete its normal browser, device-code, API-key, or other login flow as the isolated
`flock-agent` runtime identity. Credentials stay on that node and do not pass through
Shepherd's control-plane database.

## Prepare a remote node

From a matching Shepherd release checkout or deployment bundle, run the idempotent
preparation script as root:

```bash
sudo ./scripts/flock-node-prepare.sh \
  --public-key-file /path/to/flock-control.pub \
  --workspace /srv/flock/workspaces
```

This creates the SSH control identity, the separate coding-agent runtime identity, a
constrained root helper, and the runtime-owned workspace. It installs no coding tools and
does not install or expose Docker.

After registering the node, open **Paddock → node → Coding tools & Docker**. Each tool
shows its detected path/version and an **Install latest** or **Upgrade** action. Every
write requires a confirmation, has bounded output/time, is audited, and is refused while
that tool has an active Shepherd session.

The same explicit path is available to an operator at the shell:

```bash
# One tool; repeat --install-agent to select more than one.
sudo ./scripts/flock-node-prepare.sh --install-agent amp

# Deliberately install or upgrade every supported coding tool.
sudo ./scripts/flock-node-prepare.sh --install-agents
```

Re-run the preparation script from the new release to update an older node's constrained
helper. The migration is idempotent and does not restart `flock-agentd` or terminate
sessions. An older helper remains read-only compatible for detection, but the UI keeps
managed write buttons disabled until the helper is updated.

## Docker is a separate privilege decision

The node card reports four facts independently: Docker executable, daemon state, whether
the runtime identity can use it, and how that access is granted.

- **Install Docker** installs/enables the distribution package on Debian or Ubuntu. It
  does not grant agents access. Other distributions remain detectable and link to their
  official installation instructions.
- **Enable for agents** grants only `flock-agent` a persistent ACL on the system Docker
  socket. Existing human membership in the normal `docker` group is preserved.
- **Disable agent access** removes Shepherd's ACL. It is refused while the node has active
  Shepherd sessions so a running workflow is not silently broken.

Access to a normal Docker daemon is effectively root-equivalent: a process can mount the
host filesystem or start privileged containers. The UI states this before accepting the
exact confirmation. Shepherd does not imply that the ACL is a security sandbox; it only
avoids broadening the node's human Docker group. Use a dedicated node, rootless engine,
or no Docker access when that trust is inappropriate.

The bundled local `node-runtime` is intentionally different. It is immutable, receives
no host Docker socket, and updates its bundled tools only through a Shepherd runtime
image release. Use a prepared remote node for Docker workloads.

## Validation checklist

On a prepared remote node:

1. Node details lists all nine tools, including missing tools, without changing them.
2. Installing Amp (or another missing tool) requires confirmation and returns a verified
   path/version owned by the runtime identity.
3. Provider authentication is still requested by the tool itself on first launch.
4. Docker installation alone leaves **Agent access disabled**.
5. Enabling access changes the card to `system_acl`; `flock-agent` can run `docker info`
   with supplementary groups cleared, while existing human Docker-group access remains.
6. Restarting Docker reapplies the runtime ACL; disabling access removes it.
7. Every managed mutation appears in the audit log without credentials or unbounded
   installer output.

For per-agent lifecycle depth and known limitations, see the
[agent integration matrix](agent-integration-matrix.md).
