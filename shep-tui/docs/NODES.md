# Standalone vs multi-machine

## Default: standalone (no SSH, no Flock web)

`shep-tui` is **fully usable on one machine** with only `flock-agentd`:

```bash
cd shep-tui
make build
./bin/shep-tui up          # start local agentd if needed
./bin/shep-tui doctor
./bin/shep-tui sessions spawn
./bin/shep-tui             # full paddock: tree · pens · status · shell drawer
```

You get:

| Capability | Standalone |
| --- | --- |
| Durable agent PTYs | yes (`flock-agentd`) |
| Pens 1–4 + persist | yes (`~/.config/shep-tui/pens.json`) |
| Live status / Needs you | yes (agentd status frames) |
| Palette, attention list, respond | yes |
| Shell drawer | yes |
| Git / files / cost / compare | yes (local) |
| Handoff bootstrap | yes (local sessions) |

**No orchestrator. No SSH. No Flock web required.**

Sessions live in agentd and survive closing the TUI.

---

## Optional: multi-machine (fleet)

Remote SSH nodes are **optional**. They use the Flock **orchestrator** (web Settings → Nodes), not the TUI’s required path.

1. Run Flock orchestrator + web.
2. **Settings → Nodes → Add node** (SSH host/user/key).
3. Point the TUI at fleet:

```bash
export FLOCK_URL=https://your-flock
shep-tui auth login --user … --password …
shep-tui
```

See Flock `docs/architecture.md` for how the orchestrator bootstraps `flock-agentd` over SSH.

---

## API (fleet only)

```bash
curl -sS -X POST "$FLOCK_URL/api/nodes" \
  -H 'content-type: application/json' \
  -H "cookie: flock_session=…" \
  -d '{
    "name": "build-box",
    "kind": "ssh",
    "host": "10.0.0.5",
    "port": 22,
    "sshUser": "ubuntu",
    "sshAuthMethod": "key",
    "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"
  }'
```

Standalone users can ignore this entirely.
