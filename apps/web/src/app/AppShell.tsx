/**
 * AppShell — the Codex-style three-region paddock layout (US-30, Appendix A.1).
 *
 *   ┌──────────────┬───────────────────────────┬──────────────┐
 *   │  tree        │  session pane             │  activity    │
 *   │ (node→proj→  │  (terminal | browser |    │  sidebar     │
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
 *   - session  → US-33 center tab group (Terminal | Browser | Diff)
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
  // Collapsed → a fixed icon rail; expanded → a calm narrow tree.
  const treeCol = treeCollapsed ? 'var(--flock-rail-w)' : 'minmax(15rem, 18rem)';
  return (
    <div
      data-testid="app-shell"
      className="grid h-full w-full overflow-hidden bg-flock-bg text-flock-fg"
      style={{
        // Calm Codex proportions: a narrow tree (or icon rail) + a wide session
        // pane (+ a medium activity sidebar when present); an auto bottom row that
        // collapses with no drawer.
        gridTemplateColumns: hasActivity
          ? `${treeCol} minmax(0, 1fr) minmax(16rem, 22rem)`
          : `${treeCol} minmax(0, 1fr)`,
        gridTemplateRows: drawerOpen ? '1fr minmax(8rem, 16rem)' : '1fr',
        gridTemplateAreas: drawerOpen
          ? hasActivity
            ? '"tree session activity" "drawer drawer drawer"'
            : '"tree session" "drawer drawer"'
          : hasActivity
            ? '"tree session activity"'
            : '"tree session"',
      }}
    >
      <nav
        role="navigation"
        aria-label="Sessions"
        data-slot="tree"
        data-testid="region-tree"
        className="min-h-0 overflow-y-auto border-r border-flock-muted/15 bg-flock-surface"
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
          className="min-h-0 overflow-y-auto border-l border-flock-muted/15 bg-flock-surface"
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
          className="min-h-0 overflow-hidden border-t border-flock-muted/15 bg-flock-surface"
          style={{ gridArea: 'drawer' }}
        >
          {drawer}
        </section>
      ) : null}
    </div>
  );
}
