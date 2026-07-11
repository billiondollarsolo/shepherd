/**
 * Paddock — herdr-aligned shell assembly.
 *
 * One shell always: host/lens chrome via TopBar + Sidebar, stage or Mission
 * Control in center. No zen rebuild of the tree. Tools are opt-in (chrome).
 */
import { AppShell } from './AppShell';
import { KeyboardProvider } from './KeyboardProvider';
import { PaddockCommands } from './usePaddockCommands';
import { FleetView } from '../features/overview/FleetView';
import { CompareView } from '../features/overview/CompareView';
import { TooltipProvider, Toaster } from '../components/ui';
import { Sidebar } from '../features/paddock/Sidebar';
import { SessionPane } from '../features/paddock/SessionPane';
import { LiveDataProvider } from '../features/paddock/liveData';
import { BottomBar } from '../features/paddock/BottomBar';
import { TopBar } from '../features/paddock/TopBar';
import { ConnectivityBanner } from '../features/paddock/ConnectivityBanner';
import { NodePage } from '../features/paddock/NodePage';
import { PaddockDialogs } from '../features/paddock/PaddockDialogs';
import { SettingsPage } from '../features/settings/SettingsPage';
import { ShellDrawer } from '../features/shell-drawer/ShellDrawer';
import { useSessions } from '../data/queries';
import { usePaddock } from '../store/paddock';
import { FleetSelectionSync } from '../features/shell/FleetSelectionSync';

/** The currently-selected session record (from the Query cache), or null. */
function useSelectedSession() {
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const { data: sessions = [] } = useSessions();
  return selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;
}

/** The center region: node details, stage, or mission board. */
function CenterPane(): JSX.Element {
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const view = usePaddock((s) => s.view);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const lens = usePaddock((s) => s.lens);

  if (nodeInfoNodeId) return <NodePage />;

  // Paddock board when lens is mission and nothing is on stage
  // (D1 home). Opening an agent switches lens to agents and shows stage (D2).
  const showMission =
    (view === 'overview' || lens === 'mission') && !selectedSessionId && !selectedProjectId;

  if (showMission) return <FleetView />;
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
  return <ShellDrawer sessionId={session.id} workingDir={session.workingDir} />;
}

export function Paddock(): JSX.Element {
  const view = usePaddock((s) => s.view);
  const sidebarCollapsed = usePaddock((s) => s.sidebarCollapsed);
  const chrome = usePaddock((s) => s.chrome);

  return (
    <TooltipProvider delayDuration={300}>
      <KeyboardProvider>
        {view === 'settings' ? (
          <SettingsPage />
        ) : (
          <LiveDataProvider>
            <FleetSelectionSync />
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
      <Toaster />
    </TooltipProvider>
  );
}
