/**
 * URL routing (TanStack Router) — sync-only, NOT Outlet-driven.
 * herdr-aligned paths: / , /agents , /agents/:sessionId , /p/:id , /n/:id , /s/:id (compat)
 * See docs/herdr-aligned-shell-plan.md §0.8 and @flock/shared shell-nav.
 */
import { useEffect } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import {
  pathToShellNav,
  shellNavToPath,
  type HostScope,
  type ShellLens,
  type ShellChrome,
} from '@flock/shared';

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
export type NavPatch = Partial<
  Pick<
    PaddockUiState,
    | 'view'
    | 'settingsSection'
    | 'selectedSessionId'
    | 'selectedProjectId'
    | 'nodeInfoNodeId'
    | 'lens'
    | 'chrome'
    | 'hostScope'
  >
>;

/**
 * URL → store patch. Uses shared pathToShellNav; maps to paddock view fields.
 */
export function pathToNav(pathname: string): NavPatch {
  const shell = pathToShellNav(pathname);
  const patch: NavPatch = {};

  if (shell.settings) {
    patch.view = 'settings';
    if (shell.settingsSection && (SETTINGS_SECTIONS as readonly string[]).includes(shell.settingsSection)) {
      patch.settingsSection = shell.settingsSection as SettingsSection;
    }
    return patch;
  }

  if (shell.lens === 'mission' && !shell.selectedSessionId && !shell.activeProjectId) {
    patch.view = 'overview';
  } else {
    patch.view = 'paddock';
  }

  if (shell.lens !== undefined) patch.lens = shell.lens as ShellLens;
  if (shell.chrome !== undefined) patch.chrome = shell.chrome as ShellChrome;
  if (shell.hostScope !== undefined) patch.hostScope = shell.hostScope as HostScope;
  if (shell.selectedSessionId !== undefined) patch.selectedSessionId = shell.selectedSessionId;
  if (shell.activeProjectId !== undefined) patch.selectedProjectId = shell.activeProjectId;
  if (shell.nodeInfoNodeId !== undefined) patch.nodeInfoNodeId = shell.nodeInfoNodeId;

  return patch;
}

/** Inputs for navToPath — pure. */
export interface NavToPathInput {
  view: PaddockUiState['view'];
  settingsSection: SettingsSection;
  selectedSessionId: string | null;
  nodeInfoNodeId: string | null;
  /** Effective project: chosen one, else selected session's project. */
  gridProjectId: string | null;
  lens: ShellLens;
  hostScope: HostScope;
}

/** store → canonical path. */
export function navToPath(n: NavToPathInput): string {
  if (n.view === 'settings') {
    return shellNavToPath({
      settings: true,
      settingsSection: n.settingsSection,
      lens: n.lens,
      selectedSessionId: null,
      activeProjectId: null,
      nodeInfoNodeId: null,
      hostScope: n.hostScope,
    });
  }
  return shellNavToPath({
    settings: false,
    settingsSection: n.settingsSection,
    lens: n.view === 'overview' ? 'mission' : n.lens,
    selectedSessionId: n.selectedSessionId,
    activeProjectId: n.selectedSessionId ? null : n.gridProjectId,
    nodeInfoNodeId: n.nodeInfoNodeId,
    hostScope: n.hostScope,
  });
}

function applyNavPatch(patch: NavPatch): void {
  const cur = usePaddock.getState() as unknown as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (cur[k] !== v) diff[k] = v;
  }
  // When opening an agent from URL, ensure stage chrome
  if (diff.selectedSessionId && typeof diff.selectedSessionId === 'string') {
    diff.chrome = 'stage';
    diff.rightOpen = false;
  }
  if (Object.keys(diff).length > 0) usePaddock.setState(diff as Partial<PaddockUiState>);
}

function UrlStoreSync(): null {
  const { data: sessions = [] } = useSessions();

  useEffect(() => {
    const apply = (): void => applyNavPatch(pathToNav(router.state.location.pathname));
    apply();
    return router.subscribe('onResolved', apply);
  }, []);

  useEffect(() => {
    const sync = (): void => {
      const s = usePaddock.getState();
      const sessionProjectId = s.selectedSessionId
        ? (sessions.find((x) => x.id === s.selectedSessionId)?.projectId ?? null)
        : null;
      const path = navToPath({
        view: s.view,
        settingsSection: s.settingsSection,
        selectedSessionId: s.selectedSessionId,
        nodeInfoNodeId: s.nodeInfoNodeId,
        gridProjectId: s.selectedProjectId ?? sessionProjectId,
        lens: s.lens,
        hostScope: s.hostScope,
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
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: RootComponent });
const nullComponent = (): null => null;
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/agents', component: nullComponent }),
  createRoute({ getParentRoute: () => rootRoute, path: '/agents/$sessionId', component: nullComponent }),
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
