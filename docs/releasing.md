# Releasing Flock

Flock releases are GitHub Releases backed by three multi-platform images in the
GitHub Container Registry (GHCR):

- `ghcr.io/billiondollarsolo/flock-orchestrator`
- `ghcr.io/billiondollarsolo/flock-web`
- `ghcr.io/billiondollarsolo/flock-session-chrome`

The release workflow builds Linux amd64 and arm64 images, publishes semantic
version tags, generates SBOM/provenance attestations, and updates `latest` only for
non-prereleases.

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
6. Consider enabling immutable releases. If enabled, create the release as a draft,
   finish notes and assets, then publish it once.

## Prepare a version

Update all version-bearing files together:

- `agentd/VERSION` (canonical version)
- root and workspace `package.json` files
- `agentd/internal/session/flock-mcp.mjs`
- `.env.example` and versioned image defaults in `docker-compose.yml`
- `CHANGELOG.md`

Then run:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm audit --prod --audit-level high
docker compose -f docker-compose.yml config --quiet

(cd agentd && go vet ./... && go test ./... && \
  go run golang.org/x/vuln/cmd/govulncheck@latest ./... && make dist)

docker run --rm -v "$PWD:/repo:ro" \
  zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git /repo --no-banner --redact
```

Build all three images locally at least once when their Dockerfiles change:

```bash
docker build -f docker/Dockerfile.orchestrator -t flock-orchestrator:test .
docker build -f docker/Dockerfile.web -t flock-web:test .
docker build -f docker/Dockerfile.session-chrome -t flock-session-chrome:test .
```

## Publish

1. Merge the prepared release commit to `main` and wait for CI and CodeQL.
2. Create a GitHub Release for `v<version>` from that exact commit. Use a draft first
   when immutable releases are enabled.
3. Publish the release. `.github/workflows/release-images.yml` verifies that the tag
   matches the repository version and belongs to `main`, reruns the release gates,
   then builds and pushes all images.
4. For the first publication of each GHCR package, open the package settings and set
   visibility to **Public**. Package visibility is separate from repository visibility.

Do not move an existing semantic-version image tag. Fix a bad release with a new patch
version. A failed workflow may be rerun before consumers rely on its tags.

## Verify

```bash
docker buildx imagetools inspect ghcr.io/billiondollarsolo/flock-orchestrator:<version>
docker buildx imagetools inspect ghcr.io/billiondollarsolo/flock-web:<version>
docker buildx imagetools inspect ghcr.io/billiondollarsolo/flock-session-chrome:<version>

docker pull ghcr.io/billiondollarsolo/flock-orchestrator:<version>
docker pull ghcr.io/billiondollarsolo/flock-web:<version>
docker pull ghcr.io/billiondollarsolo/flock-session-chrome:<version>
```

Confirm that anonymous pulls work, both amd64 and arm64 manifests exist, provenance
is visible, release notes match `CHANGELOG.md`, and a clean-host Compose deployment
can complete first-run setup, launch an agent, reconnect its terminal, and start a
browser pane.

## Operations to plan before wider adoption

- Document and test backup/restore for Postgres, runtime secrets, the master key,
  Caddy data, and local workspaces.
- Define upgrade and rollback procedures, including database migration compatibility.
- Publish a support policy and compatibility matrix for Docker, browsers, host
  architectures, agent CLIs, and remote-node operating systems.
- Establish an incident-response path and a regular dependency/base-image update
  cadence. Dependabot opens the update pull requests; maintainers still need to review
  and release them.
