# Contributing to Flock

Thanks for helping improve Flock.

## Before opening a change

- Use GitHub Discussions or an issue for substantial behavior or architecture
  changes before investing in an implementation.
- Use GitHub private vulnerability reporting for security issues; do not file
  them publicly.
- Keep changes focused. Do not combine unrelated refactors with a feature or fix.

## Development setup

See the [Quick start](README.md#quick-start), then run:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
(cd agentd && go test ./...)
```

Integration tests require Docker. Browser tests require Playwright:

```bash
pnpm test:int
pnpm exec playwright install chromium
pnpm test:e2e
```

## Pull requests

- Add or update tests for behavior changes.
- Update documentation and `.env.example` when configuration changes.
- Keep TypeScript contracts in `packages/shared`; do not duplicate wire types.
- Never commit credentials, private keys, `.env` files, test recordings with
  private data, or generated agent transcripts.
- Confirm `pnpm release:check` when changing a release version.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
