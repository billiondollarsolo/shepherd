# Security policy

## Supported versions

Shepherd is pre-1.0 software. Security fixes are applied to the latest published
minor release only.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | Yes       |
| < 0.4   | No        |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/billiondollarsolo/shepherd/security/advisories/new)
to send a report to the maintainers.

Include the affected version, deployment model, reproduction steps, potential
impact, and any suggested mitigation. We will acknowledge a complete report
within seven days and coordinate disclosure after a fix is available.

## Security boundary

Shepherd is a single-user, self-hosted operator tool that can execute commands on
configured nodes and can forward explicitly selected node-local development
services to the operator's browser. It does not require the Docker socket. Anyone
with Shepherd administrator access should be treated as having code-execution
authority over configured nodes and access to services forwarded through Shepherd.

Run Shepherd behind HTTPS, keep it off untrusted public networks unless required,
use dedicated nodes for autonomous agents, expose Preview only on trusted networks
or isolated origins, protect backups and runtime secrets, and never reuse the
Shepherd master key or SSH credentials elsewhere.
