/**
 * URL routing (TanStack Router) — gives sessions / projects / nodes / settings
 * real, shareable, back-button-able URLs.
 *
 * DESIGN — sync-only, NOT Outlet-driven. The paddock renders from the zustand
 * store, and terminals are kept mounted across navigations (no PTY reconnect —
 * see SessionPane/GridView). If routes swapped the center via <Outlet> we'd
 * unmount terminals on every navigation. So instead:
 *   - the router OWNS the URL (history, params, back/forward, type-safe nav);
 *   - the single root route renders the existing shell ONCE; child routes render
 *     nothing (they exist only to define the URL shape);
 *   - {@link UrlStoreSync} keeps URL ⇄ store in sync both ways.
 *
 * The URL ⇄ store mapping is two PURE functions ({@link pathToNav} /
 * {@link navToPath}) so it is unit-tested without a browser, and so the two
 * directions are provably consistent (no navigation ping-pong).
 */
import { useEffect } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';

import { AuthGate } from '../features/auth/AuthGate';
import { ResponsivePaddock } from '../features/responsive';
import { useSessions } from '../data/queries';
import { usePaddock, type PaddockUiState, type SettingsSection } from '../store/paddock';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'notifications',
  'nodes',
  'account',
  'about',
];

/** The subset of store state a URL determines. */
type NavPatch = Partial<
  Pick<
    PaddockUiState,
    'view' | 'settingsSection' | 'viewMode' | 'selectedSessionId' | 'selectedProjectId' | 'nodeInfoNodeId'
  >
>;

/**
 * URL → store patch. Returns ONLY the keys a given path determines (applied as a
 * diff), so unrelated state (right panel, file viewer, …) is never clobbered.
 */
export function pathToNav(pathname: string): NavPatch {
  const seg = pathname.split('/').filter(Boolean);

  // /settings, /settings/:section
  if (seg[0] === 'settings') {
    const section = seg[1];
    if (section && (SETTINGS_SECTIONS as readonly string[]).includes(section)) {
      return { view: 'settings', settingsSection: section as SettingsSection };
    }
    return { view: 'settings' };
  }
  // /n/:nodeId — node details overlay the center (selection is left intact)
  if (seg[0] === 'n' && seg[1]) {
    return { view: 'paddock', nodeInfoNodeId: seg[1] };
  }
  // /s/:sessionId — focus a session
  if (seg[0] === 's' && seg[1]) {
    return {
      view: 'paddock',
      viewMode: 'focus',
      selectedSessionId: seg[1],
      nodeInfoNodeId: null,
    };
  }
  // /p/:projectId — that project's grid (leaves any highlighted session as-is;
  // selectedProjectId wins for grid scope)
  if (seg[0] === 'p' && seg[1]) {
    return {
      view: 'paddock',
      viewMode: 'grid',
      selectedProjectId: seg[1],
      nodeInfoNodeId: null,
    };
  }
  // / — home is Paddock: the whole fleet at a glance (fleet-first).
  return {
    view: 'overview',
    selectedSessionId: null,
    selectedProjectId: null,
    nodeInfoNodeId: null,
  };
}

/** Inputs {@link navToPath} needs — store fields plus the grid's resolved project. */
export interface NavToPathInput {
  view: PaddockUiState['view'];
  settingsSection: SettingsSection;
  viewMode: PaddockUiState['viewMode'];
  selectedSessionId: string | null;
  nodeInfoNodeId: string | null;
  /** Effective grid project: the chosen one, else the selected session's project. */
  gridProjectId: string | null;
}

/** store → canonical path. Inverse of {@link pathToNav} for the round-trip cases. */
export function navToPath(n: NavToPathInput): string {
  if (n.view === 'settings') return `/settings/${n.settingsSection}`;
  if (n.view === 'overview') return '/';
  if (n.nodeInfoNodeId) return `/n/${n.nodeInfoNodeId}`;
  if (n.viewMode === 'focus' && n.selectedSessionId) return `/s/${n.selectedSessionId}`;
  if (n.gridProjectId) return `/p/${n.gridProjectId}`;
  return '/';
}

/** Apply a URL patch to the store, setting only the keys that actually differ. */
function applyNavPatch(patch: NavPatch): void {
  const cur = usePaddock.getState() as unknown as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (cur[k] !== v) diff[k] = v;
  }
  if (Object.keys(diff).length > 0) usePaddock.setState(diff as Partial<PaddockUiState>);
}

/**
 * Keeps the URL and the store in sync both ways. Mounted inside the authed tree
 * (so the sessions query only runs when signed in). Both directions are guarded
 * by a difference check, so they converge in one step and never ping-pong.
 */
function UrlStoreSync(): null {
  const { data: sessions = [] } = useSessions();

  // URL → store: on first mount + every navigation (incl. back/forward).
  useEffect(() => {
    const apply = (): void => applyNavPatch(pathToNav(router.state.location.pathname));
    apply();
    return router.subscribe('onResolved', apply);
  }, []);

  // store → URL: derive the canonical path and push it when it changes. Resolves
  // the selected session's project (for grid URLs) from the query cache here, so
  // navToPath can stay a pure function.
  useEffect(() => {
    const sync = (): void => {
      const s = usePaddock.getState();
      const sessionProjectId = s.selectedSessionId
        ? (sessions.find((x) => x.id === s.selectedSessionId)?.projectId ?? null)
        : null;
      const path = navToPath({
        view: s.view,
        settingsSection: s.settingsSection,
        viewMode: s.viewMode,
        selectedSessionId: s.selectedSessionId,
        nodeInfoNodeId: s.nodeInfoNodeId,
        gridProjectId: s.selectedProjectId ?? sessionProjectId,
      });
      if (path !== router.state.location.pathname) router.history.push(path);
    };
    sync();
    return usePaddock.subscribe(sync);
  }, [sessions]);

  return null;
}

function RootComponent(): JSX.Element {
  return (
    <>
      <AuthGate>
        <UrlStoreSync />
        <ResponsivePaddock />
      </AuthGate>
      {/* Child routes render nothing — they exist only to define the URL shape.
          The shell above is what the user sees, driven by the store. */}
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: RootComponent });
const nullComponent = (): null => null;
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/s/$sessionId', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/p/$projectId', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/n/$nodeId', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: nullComponent }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/$section',
    component: nullComponent,
  }),
]);

export const router = createRouter({ routeTree, defaultPreload: false });
