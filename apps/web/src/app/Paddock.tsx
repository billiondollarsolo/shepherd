/**
 * Paddock — herdr-aligned shell assembly.
 *
 * One shell always: host/lens chrome via TopBar + Sidebar, stage or Paddock
 * dashboard in center. No zen rebuild of the tree. Tools are opt-in (chrome).
 */
import { lazy, Suspense } from 'react';
import { AppShell } from './AppShell';
import { KeyboardProvider } from './KeyboardProvider';
import { PaddockCommands } from './usePaddockCommands';
import { FleetView } from '../features/overview/FleetView';
import { CompareView } from '../features/overview/CompareView';
import { TooltipProvider } from '../components/ui';
import { Sidebar } from '../features/paddock/Sidebar';
import { SessionPane } from '../features/paddock/SessionPane';
import { LiveDataProvider } from '../features/paddock/liveData';
import { BottomBar } from '../features/paddock/BottomBar';
import { TopBar } from '../features/paddock/TopBar';
import { ConnectivityBanner } from '../features/paddock/ConnectivityBanner';
import { PaddockDialogs } from '../features/paddock/PaddockDialogs';
import { useSessions } from '../data/queries';
import { usePaddock } from '../store/paddock';

const NodePage = lazy(() =>
  import('../features/paddock/NodePage').then(({ NodePage: Page }) => ({ default: Page })),
);
const ProjectGitPage = lazy(() =>
  import('../features/paddock/ProjectGitPage').then(({ ProjectGitPage: Page }) => ({
    default: Page,
  })),
);
const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage').then(({ SettingsPage: Page }) => ({ default: Page })),
);
const ShellDrawer = lazy(() =>
  import('../features/shell-drawer/ShellDrawer').then(({ ShellDrawer: Drawer }) => ({
    default: Drawer,
  })),
);

function PanelLoading(): JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center text-sm text-flock-ink-muted"
      role="status"
    >
      Loading…
    </div>
  );
}

/** The currently-selected session record (from the Query cache), or null. */
function useSelectedSession() {
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const { data: sessions = [] } = useSessions();
  return selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;
}

/** The center region follows the selected top-level workspace. */
function CenterPane(): JSX.Element {
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const lens = usePaddock((s) => s.lens);
  const projectView = usePaddock((s) => s.projectView);

  if (nodeInfoNodeId)
    return (
      <Suspense fallback={<PanelLoading />}>
        <NodePage />
      </Suspense>
    );
  // Paddock is a real fleet workspace, never an overlay on the staged agent.
  // Node routes take precedence because /n/:id intentionally keeps the mission
  // lens while drilling into that fleet card.
  if (lens === 'mission') return <FleetView />;
  if (projectView === 'git')
    return (
      <Suspense fallback={<PanelLoading />}>
        <ProjectGitPage />
      </Suspense>
    );
  return <SessionPane />;
}

function DrawerContent(): JSX.Element {
  const session = useSelectedSession();
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">
        Select a session to open a shell in its working directory.
      </div>
    );
  }
  return (
    <Suspense fallback={<PanelLoading />}>
      <ShellDrawer sessionId={session.id} workingDir={session.workingDir} />
    </Suspense>
  );
}

export function Paddock(): JSX.Element {
  const view = usePaddock((s) => s.view);
  const sidebarCollapsed = usePaddock((s) => s.sidebarCollapsed);
  const chrome = usePaddock((s) => s.chrome);

  return (
    <TooltipProvider delayDuration={300}>
      <KeyboardProvider>
        {view === 'settings' ? (
          <Suspense fallback={<PanelLoading />}>
            <SettingsPage />
          </Suspense>
        ) : (
          <LiveDataProvider>
            {/* One shell always — no zen tree rebuild (plan Phase 0). */}
            <div className="h-screen w-screen overflow-hidden" data-chrome={chrome}>
              <AppShell
                tree={<Sidebar />}
                session={
                  <div className="flex h-full min-h-0 flex-col">
                    <TopBar />
                    <ConnectivityBanner />
                    <div className="min-h-0 flex-1">
                      <CenterPane />
                    </div>
                    {chrome === 'tools' ? <BottomBar /> : null}
                  </div>
                }
                drawer={<DrawerContent />}
                treeCollapsed={sidebarCollapsed}
              />
            </div>
            <CompareView />
          </LiveDataProvider>
        )}
        <PaddockCommands />
        <PaddockDialogs />
      </KeyboardProvider>
    </TooltipProvider>
  );
}
