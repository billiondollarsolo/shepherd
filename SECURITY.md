# Security policy

## Supported versions

Flock is pre-1.0 software. Security fixes are applied to the latest published
minor release only.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3   | No        |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/billiondollarsolo/flock/security/advisories/new)
to send a report to the maintainers.

Include the affected version, deployment model, reproduction steps, potential
impact, and any suggested mitigation. We will acknowledge a complete report
within seven days and coordinate disclosure after a fix is available.

## Security boundary

Flock is a single-user, self-hosted operator tool that can execute commands on
configured nodes and mounts the Docker socket when browser containers are
enabled. Anyone with Flock administrator access should be treated as having
code-execution authority over those nodes and the Docker host.

Run Flock behind HTTPS, keep it off untrusted public networks unless required,
use dedicated nodes for autonomous agents, protect backups and runtime secrets,
and never reuse the Flock master key or SSH credentials elsewhere.
