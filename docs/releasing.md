# Releasing Shepherd

Shepherd releases are GitHub Releases backed by three multi-platform images in the
GitHub Container Registry (GHCR):

- `ghcr.io/billiondollarsolo/shepherd-orchestrator`
- `ghcr.io/billiondollarsolo/shepherd-node-runtime`
- `ghcr.io/billiondollarsolo/shepherd-web`

The deployment consumes digest-pinned official Traefik and PostgreSQL images directly.
Release CI scans both upstream manifests on amd64 and arm64 but does not rebuild or
republish them.

The release workflow builds Linux amd64 and arm64 images, publishes semantic
version tags, generates SBOM/provenance attestations, and updates `latest` only for
non-prereleases. Every GitHub Release also publishes `agentd-compatibility.json`, and
the deployment bundle includes the matching idempotent node-preparation script. Release
notes include the same daemon policy so operators can inspect mandatory node requirements
before pulling the stack.

## One-time public-repository setup

Before the first public release:

1. Review the complete Git history for author identities and private infrastructure
   details, not only credentials. Rewrite history before publication if anything
   should not become permanent public metadata.
2. Make the repository public and add its description, topics, and social preview.
3. Enable private vulnerability reporting, dependency alerts, secret scanning, and
   push protection in **Settings → Code security and analysis**.
4. Protect `main` (or create an equivalent ruleset): require pull requests, the CI
   and CodeQL checks, resolved conversations, and no force pushes or deletions.
5. Keep Actions' default token permission read-only. The release workflow requests
   `packages: write` only for its image-publishing job. Require full-SHA action
   pinning after confirming every workflow is pinned.
6. After the first candidate push creates each GHCR package, an organization owner
   must set **Package settings → Change visibility → Public**. GitHub intentionally
   keeps package visibility separate from repository permissions and does not let a
   repository `GITHUB_TOKEN` elevate it. This is a one-time action per package name.
7. Consider enabling immutable releases. The workflow creates the GitHub Release only
   after all image and anonymous-access gates pass.

## Prepare a version

Update all version-bearing files together:

- `agentd/VERSION` (canonical version)
- `agentd/COMPATIBILITY.json` (minimum daemon, supported protocols, and required capabilities)
- root and workspace `package.json` files
- `agentd/internal/session/flock-mcp.mjs`
- `.env.example` and versioned image defaults in `docker-compose.yml`
- `CHANGELOG.md`

When the minimum daemon version, protocol range, or required capabilities change,
release notes must call out whether node upgrades are recommended or mandatory.
Supporting an older protocol requires its implementation and integration fixture to
remain in-tree; listing it in the manifest alone is not sufficient. Never lower the
preferred daemon to force a downgrade of a newer compatible node.

Then run:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.4.0 scan source \
  --lockfile=pnpm-lock.yaml --format=json --output-file=osv-report.json
docker compose -f docker-compose.yml config --quiet

(cd agentd && go vet ./... && go test -race ./... && \
  go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./... && make dist)

docker run --rm -v "$PWD:/repo:ro" \
  zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git /repo --no-banner --redact
```

Build all three Shepherd images locally at least once when their Dockerfiles change:

```bash
docker build -f docker/Dockerfile.orchestrator -t shepherd-orchestrator:test .
docker build -f docker/Dockerfile.node-runtime -t shepherd-node-runtime:test .
docker build -f docker/Dockerfile.web -t shepherd-web:test .

TRIVY_IMAGE='aquasec/trivy:0.66.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e'
for image in shepherd-orchestrator shepherd-node-runtime shepherd-web; do
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$PWD:/workspace:ro" \
    "$TRIVY_IMAGE" image --exit-code 1 \
    --ignorefile /workspace/.trivyignore.yaml \
    --severity HIGH,CRITICAL "$image:test"
done

for image in \
  'traefik:v3.7@sha256:1cb3845d7a05e1473c9086351426597e911db49db382b6e4769f9b0744962ac8' \
  'postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55'; do
  docker pull "$image"
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$PWD:/workspace:ro" \
    "$TRIVY_IMAGE" image --exit-code 1 \
    --ignorefile /workspace/.trivyignore.yaml \
    --severity HIGH,CRITICAL "$image"
done
```

The release gate rejects every unregistered High/Critical finding, including findings
without an upstream fix. `.trivyignore.yaml` is a visible, expiring risk register:
suppressed findings stay in the repository, the workflow uploads an unfiltered report
for every image/platform, and an overdue review automatically fails the build. Never
add a broad exception for a finding with an available fixed version. A path-scoped,
short-lived exception is permitted only when reachability review shows the affected
code is absent from the component's fixed purpose—as with the official PostgreSQL
image's non-networked `gosu` entrypoint helper—and the statement documents why waiting
for the upstream rebuild is safer than maintaining a wrapper image.

Before a destructive migration or upgrade, create and verify a vault using
[backup-and-recovery.md](backup-and-recovery.md). A release candidate is not ready if
the current vault cannot restore into an isolated database with the matching master key.
The upgrade helper compares the target release's `agentd-compatibility.json` with the
running image and requires explicit acknowledgement when the support floor, protocol
set, or required capabilities become stricter.

## Publish

1. Merge the prepared release commit to `main` and wait for CI and CodeQL.
2. Push an annotated `v<version>` tag at that exact commit. Do not create the GitHub
   Release by hand.
3. `.github/workflows/release-images.yml` verifies that the tag matches the repository
   version and belongs to `main`, reruns the release gates, scans the two upstream
   infrastructure pins, then builds and pushes all three Shepherd images. After every
   candidate passes, the workflow also creates the immutable nested
   Go module tag `agentd/v<version>` at the same commit.
   Go consumers import `github.com/billiondollarsolo/flock/agentd`; never move or
   recreate that tag.
4. The promotion job logs out of GHCR and proves that every release image is public and
   that both architectures can be inspected anonymously before it creates the GitHub
   Release. A visibility failure blocks publication with the package setting to fix.

Do not move an existing semantic-version image tag. Fix a bad release with a new patch
version. A failed workflow may be rerun before consumers rely on its tags.

## Verify

```bash
docker buildx imagetools inspect ghcr.io/billiondollarsolo/shepherd-orchestrator:<version>
docker buildx imagetools inspect ghcr.io/billiondollarsolo/shepherd-node-runtime:<version>
docker buildx imagetools inspect ghcr.io/billiondollarsolo/shepherd-web:<version>

docker pull ghcr.io/billiondollarsolo/shepherd-orchestrator:<version>
docker pull ghcr.io/billiondollarsolo/shepherd-node-runtime:<version>
docker pull ghcr.io/billiondollarsolo/shepherd-web:<version>
docker pull 'traefik:v3.7@sha256:1cb3845d7a05e1473c9086351426597e911db49db382b6e4769f9b0744962ac8'
docker pull 'postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55'
```

Confirm that anonymous pulls work, both amd64 and arm64 manifests exist, provenance
is visible, release notes match `CHANGELOG.md`, and a clean-host Compose deployment
can complete first-run setup, launch an agent, reconnect its terminal, and open/revoke
a Remote Preview. The workflow attaches `agent-versions.txt` and a redacted candidate
diagnostics snapshot to the GitHub Release. The orchestrator image also contains
`/usr/share/flock/agent-versions.txt`; Settings → Operations reports the exact tools in
the running installation, including a first-start Claude installation or a user override.

## Ongoing release operations

- Run the documented vault/restore drill and retain the prior verified rollback.
- Publish a support policy and compatibility matrix for Docker, browsers, host
  architectures, agent CLIs, and remote-node operating systems.
- Establish an incident-response path and a regular dependency/base-image update
  cadence. Dependabot opens the update pull requests; maintainers still need to review
  and release them.

## Compatibility and support window

The checked-in compatibility manifest is the release contract for remote node
daemons. Shepherd distinguishes compatible nodes, recommended maintenance, and mandatory
upgrades using authenticated protocol/capability facts plus semantic versions. The
default support promise is one minor release line and 90 days after replacement,
whichever is longer. Before 1.0, an intentional exception must be explicit in release
notes.

Database migrations follow expand/migrate/contract sequencing across the supported
rollback window. Do not ship destructive contraction while the oldest supported
application version may still be restored. Shepherd application and daemon artifacts
remain immutable; exact upstream edge/database digests are version-coupled in the
deployment bundle. External coding-agent CLIs are reported integrations and require
their own matrix tests.
