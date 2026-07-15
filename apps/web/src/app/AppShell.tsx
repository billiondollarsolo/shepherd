/**
 * AppShell — the Codex-style three-region paddock layout (US-30, Appendix A.1).
 *
 *   ┌──────────────┬───────────────────────────┬──────────────┐
 *   │  tree        │  session pane             │  activity    │
 *   │ (node→proj→  │  (terminal | preview |    │  sidebar     │
 *   │  session)    │   diff land here later)   │              │
 *   ├──────────────┴───────────────────────────┴──────────────┤
 *   │  shell drawer (Cmd+J, toggleable)                        │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Layout is a CSS grid so the proportions stay calm and stable and the bottom
 * drawer can appear/disappear without reflowing the three columns. Each region
 * is a labelled ARIA landmark and carries a stable `data-slot` + `data-testid`
 * so later UI stories mount their content here without touching this file:
 *   - tree     → US-32 supervision tree
 *   - session  → center tab group (Terminal | Preview | Diff)
 *   - activity → US-34 right activity sidebar
 *   - drawer   → US-35 second shell in the working dir
 *
 * Opening/closing the drawer and the command palette is owned by
 * KeyboardProvider; AppShell is presentational and controlled.
 */
import type { ReactNode } from 'react';
import { useShellOptional } from './KeyboardProvider';

export interface AppShellProps {
  /** Left region: node → project → session tree (US-32). */
  readonly tree?: ReactNode;
  /** Center region: live session pane / tab group (US-33). */
  readonly session?: ReactNode;
  /** Right region: activity sidebar (US-34). */
  readonly activity?: ReactNode;
  /** Bottom region: secondary shell drawer (US-35); rendered only when open. */
  readonly drawer?: ReactNode;
  /** Whether the bottom shell drawer is open (Cmd+J). */
  readonly drawerOpen?: boolean;
  /** Collapse the left tree to an icon-only rail (`--flock-rail-w`). */
  readonly treeCollapsed?: boolean;
}

export function AppShell({
  tree,
  session,
  activity,
  drawer,
  drawerOpen: drawerOpenProp = false,
  treeCollapsed = false,
}: AppShellProps): JSX.Element {
  // Read the drawer state from the shell CONTEXT (set by ⌘J / the toolbar button).
  // The prop is a fallback for standalone rendering (tests). The old prop-injection
  // via cloneElement couldn't reach this nested AppShell → the toggle was a no-op.
  const drawerOpen = useShellOptional()?.drawerOpen ?? drawerOpenProp;
  // The activity region is optional: when omitted (the Codex-style layout where
  // Browser/Diff/Activity live in the session pane's own right panel), the shell
  // is a 2-column tree | session grid.
  const hasActivity = activity != null;
  // Collapsed → a fixed icon rail; expanded → a fixed-width tree bound to the
  // authoritative --flock-sidebar-w token (Codex-like; the phone path is handled
  // elsewhere by ResponsivePaddock).
  const treeCol = treeCollapsed ? 'var(--flock-rail-w)' : 'var(--flock-sidebar-w)';
  return (
    <div
      data-testid="app-shell"
      // First-class surface-0 / ink-primary tokens (the bg-flock-bg / flock-fg
      // legacy aliases are deprecated in shell files).
      className="grid h-full w-full overflow-hidden bg-flock-surface-0 text-flock-ink-primary"
      style={{
        // Calm Codex proportions: a fixed-width tree (or icon rail) + a wide
        // session pane (+ a fixed-width activity sidebar when present), all bound
        // to authoritative layout tokens. The bottom drawer row animates between
        // 0 and --flock-drawer-h so opening/closing it is calm, not a hard jump;
        // the drawer section itself is still mounted only when open.
        gridTemplateColumns: hasActivity
          ? `${treeCol} minmax(0, 1fr) var(--flock-activity-w)`
          : `${treeCol} minmax(0, 1fr)`,
        gridTemplateRows: drawerOpen ? '1fr var(--flock-drawer-h)' : '1fr 0px',
        gridTemplateAreas: drawerOpen
          ? hasActivity
            ? '"tree session activity" "drawer drawer drawer"'
            : '"tree session" "drawer drawer"'
          : hasActivity
            ? '"tree session activity"'
            : '"tree session"',
        // Calm layout motion: animate the drawer row height on the shared motion
        // tokens (the global prefers-reduced-motion block collapses this).
        transition: 'grid-template-rows var(--flock-dur-base) var(--flock-ease-standard)',
      }}
    >
      <nav
        role="navigation"
        aria-label="Sessions"
        data-slot="tree"
        data-testid="region-tree"
        className="min-h-0 overflow-y-auto border-r border-[var(--flock-border)] bg-flock-surface-1"
        style={{ gridArea: 'tree' }}
      >
        {tree}
      </nav>

      <main
        role="main"
        aria-label="Session"
        data-slot="session"
        data-testid="region-session"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ gridArea: 'session' }}
      >
        {session}
      </main>

      {hasActivity ? (
        <aside
          role="complementary"
          aria-label="Activity"
          data-slot="activity"
          data-testid="region-activity"
          className="min-h-0 overflow-y-auto border-l border-[var(--flock-border)] bg-flock-surface-1"
          style={{ gridArea: 'activity' }}
        >
          {activity}
        </aside>
      ) : null}

      {drawerOpen ? (
        <section
          aria-label="Shell drawer"
          data-slot="drawer"
          data-testid="region-drawer"
          className="min-h-0 overflow-hidden border-t border-[var(--flock-border)] bg-flock-surface-1"
          style={{ gridArea: 'drawer' }}
        >
          {drawer}
        </section>
      ) : null}
    </div>
  );
}
