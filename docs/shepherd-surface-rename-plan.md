# Shepherd Surface Rename Plan

**Status:** Implemented and validated — targeting v0.3.0
**Prepared:** 2026-07-13  
**Implemented:** 2026-07-13  
**Scope:** User-visible product rename from **Flock** to **Shepherd**  
**Tagline:** **Shepherd Your Agents**  
**Compatibility posture:** Preserve all technical identifiers during this phase

## 1. Objective

Rename the product users see from **Flock** to **Shepherd** without changing the
technical identity of the running system. This is a surface rename: the wordmark,
application copy, browser/PWA identity, public documentation, operator-facing text,
and repository presentation should consistently say **Shepherd**.

The deeper migration of package names, daemon names, environment variables, image
names, storage keys, Go module paths, and protocol fields will be planned and shipped
separately. The GitHub repository itself has moved to `billiondollarsolo/shepherd`, with
GitHub preserving redirects from the former URL. Keeping the remaining boundary strict
makes this change low risk and compatible with existing installations and nodes.

## 2. Brand contract

Implementation should begin by agreeing on this small contract and using it everywhere:

| Item                                           | Value                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Product name                                   | `Shepherd`                                                             |
| Primary wordmark                               | `Shepherd`                                                             |
| Tagline                                        | `Shepherd Your Agents`                                                 |
| Sentence-case tagline when grammar requires it | `Shepherd your agents`                                                 |
| Short description                              | `Manage nodes, projects, and CLI coding agents from one web paddock.`  |
| Existing brand glyph                           | Keep the current sheep mark for this phase                             |
| Existing visual system                         | Keep the current colors, Geist wordmark font, and paddock/pen language |
| Version presentation                           | `Shepherd v0.3.0` or the actual injected version                       |

The product name is **Shepherd**, while “flock” may remain as an ordinary lowercase
noun where it reads naturally. Capitalized **Flock** must no longer appear as product
branding outside the explicit compatibility allowlist.

## 3. Scope boundary

### 3.1 In scope

- Desktop, tablet, and mobile wordmarks.
- Authentication, first-run setup, loading, empty, error, and reconnect screens.
- Settings, About, Operations, node-preflight, session, dialog, tooltip, and accessible
  copy that names the product.
- Browser title and mobile installed-app identity.
- PWA manifest, icon accessible names, service-worker notification fallback titles,
  and other public static metadata.
- README product narrative, headings, image alt text, and public-facing examples.
- User-facing documentation, especially the documentation index, deployment guide,
  release guide, architecture introductions, security guides, and current roadmaps.
- GitHub issue forms, release display titles, repository description/topics, and About
  link labels.
- Operator-facing messages printed by supported scripts and CLIs when the text refers to
  the product rather than a literal command, file, user, service, or image name.
- GHCR image names, because no public release existed when `v0.3.0` was prepared and
  therefore no container compatibility contract needed preserving.
- Tests and validation that assert any renamed user-visible copy.

### 3.2 Explicitly out of scope

The following identifiers remain unchanged even when visible in advanced technical
documentation. Renaming them now would be a migration, not a surface change.

| Keep unchanged                                                                                                     | Reason                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Go module `github.com/billiondollarsolo/flock/agentd`                                                              | Public import compatibility                                          |
| npm packages such as `@flock/web`, `@flock/shared`, and `@flock/orchestrator`                                      | Workspace and package compatibility                                  |
| Executables/services such as `flock-agentd` and `flock-node-admin`                                                 | Installed-node and systemd compatibility                             |
| Environment variables beginning `FLOCK_`                                                                           | Deployment compatibility and secrets/configuration stability         |
| Compose project, database, OS users, directories, and volumes named `flock*`                                       | Existing installation compatibility                                  |
| Scripts and filenames such as `flock-upgrade.sh` and `flock-node-prepare.sh`                                       | Automation and documentation links                                   |
| API/diagnostic/backup fields such as `flockVersion` or `versions.flock`                                            | Serialized contract compatibility                                    |
| Backup magic, schemas, migrations, database values, audit actions, and protocol fields                             | Restore and wire compatibility                                       |
| Local-storage keys, cache names, CSS variables/classes, and persisted preferences beginning `flock.` or `--flock-` | Avoid resetting user state and creating a dual-token theme migration |
| MCP server IDs, hook paths, tmux/session prefixes, and agent config paths                                          | Existing session and agent integration compatibility                 |
| Internal TypeScript/Go symbols such as `FlockNode`, `FlockDiagnostics`, or `FlockMark`                             | No user benefit; defer mechanical churn to the deeper rename         |
| Historical release notes and immutable artifacts                                                                   | Preserve historical accuracy                                         |

Technical documentation must use wording such as “Shepherd currently ships the
`flock-agentd` service” when a product sentence and a retained identifier appear
together. Do not disguise literal commands or paths by changing their spelling.

## 4. Decisions required before implementation

These decisions should be recorded at the top of the implementation pull request:

1. **Canonical public URL.** No separate marketing-site source was found in this
   repository. Confirm whether “website” means the web application/PWA only, or whether
   an external landing page also needs a coordinated update.
2. **Repository slug.** Use `github.com/billiondollarsolo/shepherd` as the canonical
   public URL. Keep the published Go module and compatibility-sensitive technical
   `flock-*` identifiers stable; use `shepherd-*` for the first public container images.
3. **Icon.** The recommendation is to retain the current sheep glyph and blue tile. Only
   its accessible name changes. A new icon is a visual-identity project, not necessary
   for this rename.
4. **Release boundary.** Choose whether the surface rename ships as the next patch or
   minor release. Do not change the version merely because the name changed; use normal
   release policy.

None of these decisions should block writing or testing the code except the external
website task, which cannot be completed without its location and access.

### Implementation decisions

- The website in this repository is the web application/PWA. No separate marketing-site
  source or configured GitHub homepage exists, so there is no external site to migrate in
  this phase.
- The repository is now `billiondollarsolo/shepherd`; GitHub redirects the former URL.
  The About link and public documentation use the canonical Shepherd URL.
- The current sheep glyph, blue tile, and Geist wordmark font are retained. No new social
  preview is required for the surface rename.
- The version remains `0.3.0` until the normal next release. `CHANGELOG.md` contains an
  Unreleased migration note, and release display titles now use Shepherd.

## 5. Current surface inventory

The repository currently contains roughly 400 files with a case-insensitive “flock”
match. Most are internal identifiers covered by the exclusion list. The user-visible
rename is concentrated in these areas:

| Surface                   | Primary locations                                                                                                     | Expected result                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Desktop sidebar           | `apps/web/src/features/paddock/Sidebar.tsx`                                                                           | Shepherd wordmark, tagline, home label, tooltip, and version footer                     |
| Mobile header/menu        | `apps/web/src/features/responsive/PhoneView.tsx`                                                                      | Shepherd wordmark in both compact and expanded mobile states                            |
| Authentication            | `apps/web/src/features/auth/AuthScreen.tsx`, `apps/web/src/routes/Login.tsx`, `apps/web/src/routes/Setup.tsx`         | “Sign in to Shepherd,” “Set up Shepherd,” and updated brand lockup                      |
| Loading state             | `apps/web/src/features/responsive/ResponsivePaddock.tsx`                                                              | “Opening Shepherd…”                                                                     |
| Settings/About            | `apps/web/src/features/settings/SettingsPage.tsx`, `sections/AboutSection.tsx`, `sections/OperationsSection.tsx`      | Shepherd headings, repository link label, and version labels                            |
| Product-specific controls | `SessionPane.tsx`, `AddSessionDialog.tsx`, `RaceDialog.tsx`, `NodePage.tsx`                                           | Rename authority, explanatory, upgrade, and safety copy                                 |
| Browser/PWA               | `apps/web/index.html`, `apps/web/public/manifest.webmanifest`, `apps/web/public/sw.js`, `apps/web/public/icons/*.svg` | Shepherd browser title, install name, notification fallback, and accessible icon labels |
| Public overview           | `README.md`, `docs/README.md`                                                                                         | Shepherd name, tagline, narrative, and accurate retained technical names                |
| Operations docs           | `docs/deployment.md`, `docs/releasing.md`, security and architecture introductions                                    | Shepherd prose with literal retained commands and canonical `shepherd-*` images         |
| GitHub presentation       | `.github/ISSUE_TEMPLATE/*`, release workflow display title, repository settings                                       | Shepherd-facing forms, release titles, repository, and image identifiers                |
| Package presentation      | Root/web/shared package descriptions                                                                                  | Shepherd descriptions; package `name` fields remain unchanged                           |
| Operator output           | Node preparation, upgrade, vault, diagnostics, and preflight messages                                                 | Shepherd prose; technical commands, fields, and paths remain unchanged                  |

## 6. Implementation strategy

### Phase 0 — Establish a controlled rename map

Create a short implementation checklist from the inventory before editing.

Tasks:

- Record the brand contract from section 2 in the implementation pull request.
- Produce two lists from repository search:
  - user-visible occurrences that must become Shepherd;
  - retained technical occurrences, grouped by the exclusions in section 3.2.
- Treat test fixture values such as a project named “Flock” separately. A fixture is not
  branding unless the test explicitly exercises branded copy.
- Add a temporary review command or script that reports capitalized `Flock` occurrences
  not in the retained-identifier allowlist.
- Do not use a blind global replacement. Every changed occurrence must be classified.

Definition of done:

- Every current capitalized product reference has an explicit rename/retain decision.
- The allowlist contains categories and reasons, not hundreds of unexplained line-level
  exceptions.

### Phase 1 — Centralize runtime brand copy

Avoid scattering the new product name through React components again.

Tasks:

- Add a small web brand module, for example `apps/web/src/brand.ts`, exporting immutable
  values such as `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `PRODUCT_DESCRIPTION`, and
  `PRODUCT_REPOSITORY_URL`.
- Use those values for React-rendered name, tagline, About link, accessible labels, and
  version presentation where interpolation is practical.
- Keep the existing version source (`FLOCK_VERSION` / `__FLOCK_VERSION__`) unchanged;
  only change the label rendered next to it.
- Do not rename theme tokens, persisted keys, shared domain types, or the existing mark
  component as part of this phase.
- Add a focused unit test that locks the approved brand contract.

Reasoning:

The product will inevitably appear in multiple layouts. A tiny brand module prevents
desktop/mobile/auth/settings drift without introducing a large branding framework.
Static HTML, manifest, SVG, and service-worker files cannot all consume the TypeScript
module directly, so a later validation step must ensure they match it.

Definition of done:

- React-visible product naming comes from one source wherever practical.
- No compatibility-sensitive constant was renamed.

### Phase 2 — Rename the complete web application surface

Tasks:

- Update desktop sidebar wordmark from Flock to Shepherd.
- Keep “Shepherd Your Agents” directly beneath the wordmark and ensure the two-line lockup
  remains no taller than the sheep logo.
- Update collapsed-sidebar accessible labels and tooltip from “Flock home/version” to
  “Shepherd home/version.”
- Update both mobile brand presentations, including the compact header and open menu.
- Update auth and setup headings, calls to action, supporting text, and document-visible
  brand lockups.
- Update loading, reconnect, offline, and error copy that names the product.
- Update Settings, About, and Operations product/version labels.
- Update “Flock authority” to “Shepherd authority” wherever it is a user-facing
  orchestration-control concept. Keep serialized authority fields unchanged.
- Update dialog and page prose such as race-task explanations, node preparation, upgrade
  safety, and session tooltips.
- Update icon and mark `aria-label` values to Shepherd while retaining the existing glyph.
- Check the longer “Shepherd” wordmark at every responsive breakpoint; do not solve
  overflow by shrinking it below the current intended prominence.

Definition of done:

- No user-visible application state presents Flock as the product name.
- Desktop, collapsed desktop, phone portrait, phone landscape, and tablet widths fit the
  new wordmark without clipping or overlapping controls.
- Existing project/node/session names containing “Flock” remain untouched user data.

### Phase 3 — Rename browser, PWA, and notification identity

Tasks:

- Change the HTML document title to Shepherd.
- Change `apple-mobile-web-app-title` to Shepherd.
- Change manifest `name` to `Shepherd — Agent Paddock` and `short_name` to `Shepherd`.
- Confirm installed-name behavior on iOS and Android; “Shepherd” is longer than “Flock”
  but should fit normal launcher constraints.
- Change SVG accessible names from Flock to Shepherd without replacing the art.
- Change service-worker fallback notification titles to Shepherd.
- Keep service-worker cache keys and notification tags beginning `flock-` unchanged in
  this phase because they are technical/persisted identifiers.
- Add or update the public meta description using the approved short description.
- If Open Graph/Twitter metadata already exists by implementation time, update its
  product copy. Do not invent a canonical domain or social-image URL.
- Bump the PWA shell-cache version only if needed to ensure installed clients receive
  changed static metadata; verify rather than guessing.

Definition of done:

- Browser tabs, Add to Home Screen, installed PWA launchers, offline shell, and default
  push notifications identify the product as Shepherd.
- Existing service workers upgrade cleanly without stranding old caches.

### Phase 4 — Rewrite README and public documentation

Tasks:

- Change the README title, logo alt text, tagline, “What is…” heading, product narrative,
  release statement, license sentence, and other prose to Shepherd.
- Use the canonical Shepherd clone URL while keeping directory names, commands,
  environment variables, daemon names, script names, paths, and configuration examples
  exactly accurate. Use canonical `shepherd-*` public image names.
- Use the pattern “Shepherd runs `flock-agentd`” when prose meets a retained identifier.
- Update `docs/README.md` so the documentation landing page clearly names Shepherd and
  explains that technical identifiers retain the `flock` prefix during the transition.
- Update current user/operator documentation, including deployment, releasing, security,
  architecture, agent integration, and active roadmap introductions.
- Do not rewrite immutable historical release notes. For older design/decision records,
  update the current title/intro where useful but preserve historical statements whose
  meaning depends on the old name.
- Validate every README badge, GitHub URL, GHCR pull command, and intra-doc link after
  the prose edit.
- Add a short transition note: “Shepherd was previously named Flock; technical
  identifiers retain the `flock` prefix in this release.” This prevents users from
  assuming commands shown in the docs are stale.

Definition of done:

- A new reader sees Shepherd consistently as the product.
- Every copied command still works.
- Documentation explains, once and clearly, why technical names still say `flock`.

### Phase 5 — Update repository and operator-facing presentation

Tasks:

- Update root and workspace package descriptions and repository metadata to Shepherd
  while leaving package `name` values unchanged.
- Update GitHub issue-template descriptions and labels to Shepherd.
- Update release display titles from `Flock <version>` to `Shepherd <version>` while
  preserving tags, release assets, and version-check logic.
- Update the About link label and target to the canonical Shepherd repository.
- Update operator-facing log/error/help text in supported scripts and backend routes when
  it describes the product. Do not rename literal commands, services, users, or files.
- In GitHub repository settings, manually update:
  - description;
  - website URL once confirmed;
  - social preview if a Shepherd asset exists;
  - topics only if they currently contain obsolete product-brand terms.
- Publish the first public images as `shepherd-orchestrator`, `shepherd-web`, and
  `shepherd-session-chrome`; remove unreleased private `flock-*` candidates.

Definition of done:

- GitHub pages, issue creation, release pages, package descriptions, About, and operator
  messages present Shepherd consistently.
- Compose pulls, upgrades, and node provisioning resolve the canonical `shepherd-*`
  images.

### Phase 6 — Test, audit, and release

Tasks:

- Update copy assertions in unit and E2E tests.
- Do not mechanically rename fixture projects/nodes/sessions called “Flock” unless the
  fixture is intended to assert brand copy.
- Add a brand-surface audit script that:
  - checks the expected Shepherd values in HTML, manifest, service worker, icons, README,
    and key React surfaces;
  - reports unapproved capitalized `Flock` product references;
  - ignores documented compatibility identifiers and lowercase generic nouns.
- Add the audit to `quality:docs` or another existing CI quality gate rather than
  creating an isolated check nobody runs.
- Build production assets and inspect the built HTML/manifest, not only source files.
- Exercise the service-worker update path from the current Flock-branded build to the
  Shepherd-branded build.
- Perform desktop and mobile visual checks against the live production build.
- Ship the rename in one release so users do not see mixed branding across web,
  notifications, documentation, and About.

Definition of done:

- All automated and manual validations in section 8 pass.
- The compatibility allowlist is reviewed and checked into the repository with a clear
  removal plan for the deeper rename.
- Release notes explicitly describe this as a surface rename with unchanged commands and
  deployment identifiers.

## 7. Detailed task checklist

### Web and wordmark

- [x] Create the approved runtime brand constants.
- [x] Rename desktop expanded wordmark.
- [x] Rename desktop collapsed labels/tooltips.
- [x] Rename phone compact header.
- [x] Rename phone expanded menu/header.
- [x] Preserve the current sheep mark and wordmark font.
- [x] Verify wordmark/tagline vertical alignment and sidebar width.
- [x] Rename auth/login/setup surfaces.
- [x] Rename loading/reconnect/offline/error surfaces.
- [x] Rename Settings, About, and Operations labels.
- [x] Rename user-facing authority and explanatory copy.
- [x] Update all visible version labels to Shepherd.
- [x] Update accessible names and screen-reader labels.

### Browser and PWA

- [x] Update document title.
- [x] Update Apple mobile title.
- [x] Update manifest name and short name.
- [x] Update manifest/public description if applicable.
- [x] Update icon accessible names.
- [x] Update notification fallback titles.
- [x] Validate service-worker cache upgrade behavior.
- [x] Validate iOS installed-app metadata and mobile fit in WebKit.
- [x] Validate Android/Chromium PWA install metadata and service-worker registration.

### README, docs, and website

- [x] Rewrite README title/tagline/overview as Shepherd.
- [x] Add the temporary technical-identifier transition note.
- [x] Update docs landing page.
- [x] Update deployment and release prose.
- [x] Update current security and architecture introductions.
- [x] Update active plans/roadmaps where the current product is named.
- [x] Preserve historical records where rewriting would be inaccurate.
- [x] Validate commands, links, badges, images, and anchors.
- [x] Confirm there is no external marketing-site source or configured homepage in scope.

### Repository and release presentation

- [x] Update package descriptions, not package names.
- [x] Update issue forms.
- [x] Update release display titles, not tags/assets/images.
- [x] Update About link label, not its URL.
- [x] Update the GitHub description; retain the empty homepage until a canonical URL exists.
- [x] Retain the existing sheep asset; no new social preview is required for this phase.

### Operator surfaces

- [x] Audit node-preflight labels/messages.
- [x] Audit upgrade and preparation script prose.
- [x] Audit backup/vault CLI display text while preserving format identifiers.
- [x] Audit diagnostics display labels while preserving JSON fields.
- [x] Audit notification/email/push defaults.
- [x] Audit health/service display names only where changing them is non-contractual.

### Guardrails

- [x] Create the retained-identifier allowlist.
- [x] Add the brand-surface audit to CI.
- [x] Confirm no persisted key or serialized contract changed.
- [x] Confirm no repository, package, image, executable, service, user, or path was renamed.
- [x] Confirm no migration or compatibility shim is needed for this phase.

## 8. Testing and validation

### 8.1 Automated validation

Run at minimum:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm build
pnpm test:e2e:smoke
pnpm quality:docs
pnpm release:check
git diff --check
```

Also run the new brand audit and confirm:

- Shepherd appears in the runtime brand contract.
- Built `index.html` has the Shepherd title and description.
- The built/copied manifest names Shepherd.
- The shipped service worker uses Shepherd for notification fallback titles.
- Both SVG icons expose Shepherd as their accessible name.
- Capitalized Flock references are either absent or explicitly allowed as technical or
  historical references.
- Package names, Go modules, images, environment variables, and serialized fields remain
  byte-for-byte unchanged unless separately approved.

### 8.2 Browser matrix

Validate these routes and states in Chromium desktop and WebKit mobile:

| Area            | Validation                                                                |
| --------------- | ------------------------------------------------------------------------- |
| Sign in         | Shepherd lockup, title, tagline, form fit, no horizontal overflow         |
| First-run setup | Shepherd heading and accessible branding                                  |
| Paddock desktop | Expanded and collapsed sidebar; version footer; wordmark alignment        |
| Paddock phone   | Compact header, burger menu, node/project/session navigation, no clipping |
| Settings/About  | Shepherd name, actual version, valid GitHub link                          |
| Operations      | Shepherd version label with unchanged diagnostics payload                 |
| Node details    | Shepherd product/preflight copy with literal `flock-agentd` names intact  |
| Session views   | Shepherd authority/tooltips; terminals unaffected                         |
| Offline/PWA     | Installed name, offline shell, cached update, notification fallback title |

Use at least these viewport classes:

- 390 × 844 (iPhone-class portrait)
- 844 × 390 (phone landscape)
- 768 × 1024 (tablet)
- 1440 × 900 (desktop)
- desktop with collapsed sidebar

### 8.3 Accessibility validation

- The sheep mark announces “Shepherd,” not “Flock.”
- “Shepherd home” is the accessible name of the home control.
- The longer wordmark does not create duplicate or clipped accessible labels.
- Heading hierarchy on login, setup, Settings, and About remains correct.
- Axe smoke tests remain clean at desktop and phone breakpoints.

### 8.4 Compatibility validation

Prove the rename did not change behavior:

- An existing browser retains theme, layout, pen, and sidebar preferences.
- An existing installation starts with the same `.env` file.
- Existing nodes connect without re-provisioning or agentd upgrades.
- Existing sessions reconnect.
- Existing backups can be listed, verified, and restored.
- Canonical Compose image references and GHCR pulls resolve under `shepherd-*`.
- Existing clone URLs, Go imports, scripts, and upgrade commands still work.
- Diagnostics and APIs retain current field names.

### 8.5 Manual content review

- Search the rendered application, not just source, for Flock branding.
- Read the README from top to bottom and execute or syntax-check every quick-start command.
- Review documentation links and ensure retained non-image `flock-*` names are visibly
  intentional.
- Inspect GitHub issue forms and a draft release page before publishing.
- Test a push notification whose payload omits a title to exercise the service-worker
  Shepherd fallback.

## 9. Definition of done

The surface rename is complete only when all of the following are true:

1. Users see **Shepherd** in the web app, installed PWA, notifications, About, README,
   current documentation, issue forms, and release presentation.
2. The primary wordmark reads **Shepherd** and the tagline reads **Shepherd Your Agents**
   on supported desktop and mobile layouts.
3. No visible state accidentally presents Flock as the current product name.
4. Remaining `Flock`/`flock` occurrences are intentional technical identifiers, generic
   nouns, or historical statements and are covered by a reviewed policy.
5. Existing installations, users, preferences, sessions, nodes, backups, scripts,
   images, releases, and links require no migration.
6. The actual application version remains sourced from the canonical version file and
   is displayed as `Shepherd v<version>`.
7. All automated checks and the browser/accessibility/compatibility matrices pass.
8. The release notes clearly say that technical names still use the `flock` prefix and
   will be addressed in a later, migration-aware phase.

## 10. Rollout and rollback

### Rollout

- Merge the surface rename as one cohesive change after CI and visual review.
- Deploy it as a normal versioned release; do not overwrite an existing release tag.
- Include before/after desktop and mobile screenshots in the pull request.
- In release notes, lead with the new name and explicitly state that deployment commands,
  environment variables, and node services retain compatibility names while public
  images use `shepherd-*`.
- After deployment, verify browser title, PWA metadata, About version/link, notification
  fallback, and one live node/session workflow.

### Rollback

Because this phase changes presentation only, rollback is the previous application image
and documentation revision. No database rollback, node rollback, preference migration,
or backup conversion should be necessary. If any such rollback is required, the change
crossed the surface-rename boundary and must not ship under this plan.

## 11. Risks and mitigations

| Risk                                                  | Mitigation                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Blind replacement breaks commands/imports/images      | Classify occurrences and enforce an explicit retained-identifier policy                  |
| Mixed Flock/Shepherd UI                               | Central runtime brand constants plus static-asset audit                                  |
| PWA continues showing cached Flock metadata           | Test upgrade behavior and deliberately version the shell cache if required               |
| Longer wordmark clips on mobile/sidebar               | Test all named breakpoints and collapsed states before merge                             |
| Users think `flock-*` commands are obsolete           | Add one concise transition note and preserve literal formatting                          |
| Repository/image rename breaks Go or deployment links | Preserve the Go module path and validate every canonical Compose/GHCR reference          |
| Backup/diagnostic contracts change with display copy  | Change labels only; contract tests assert fields remain stable                           |
| Historical docs become misleading                     | Preserve historical statements and update only current-facing framing                    |
| External website remains stale                        | Confirm its owner/source before implementation and track it as a coordinated launch task |

## 12. Completion evidence

The implemented surface rename was validated on 2026-07-13 with:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `git diff --check`.
- `pnpm test:unit`: 1,339 tests passed across shared, orchestrator, and web.
- Dockerized `make test-int`: 111 integration tests passed, including vault
  backup/verify/isolated restore, SSH transport, node credentials, preferences, and
  deployment contracts.
- `pnpm build` plus `node scripts/check-brand-surface.mjs --dist`: production HTML,
  manifest, service worker, and icons all present Shepherd branding.
- `pnpm test:e2e:smoke`: 29 Chromium/WebKit tests passed across accessibility, policy,
  brand fit, mobile routes, dialogs, and terminal behavior.
- Additional Chromium browser coverage for document/PWA metadata, desktop shell, command
  palette, and responsive routing: 10 tests passed.
- Wordmark fit checks at 390×844, 844×390, 768×1024, and 1440×900, including the
  collapsed desktop rail.
- `pnpm quality`: dead-code, architecture, duplication, bundle, performance,
  documentation, and built-brand gates passed.
- `pnpm release:check`, agentd `go test ./...`, `go vet ./...`, and deterministic output
  from both compatibility generators.
- Manual rendered inspection of desktop, mobile, desktop sign-in, and mobile sign-in
  surfaces on the live development server.
- GitHub repository description verified as Shepherd while the repository slug and
  homepage remain unchanged.

## 13. Follow-up: deeper rename

The later migration should receive its own design document. It may consider:

- GitHub repository rename and redirects.
- New Go module and npm package paths.
- `SHEPHERD_*` environment variables with `FLOCK_*` compatibility aliases.
- Executable, systemd service, OS user, directory, and script renames.
- CSS/custom-property, storage-key, cache, hook, MCP, and session-prefix migration.
- Backup/diagnostic schema evolution and versioned readers.
- Node upgrade order, mixed-version support, and rollback.
- Repository and website domain transition.
- Deprecation timelines and long-term compatibility policy.

None of those deeper changes are prerequisites for presenting a coherent Shepherd brand
now. Keeping them separate is the central safety property of this plan.
