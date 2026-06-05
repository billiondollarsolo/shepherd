/**
 * Paddock — the assembled Codex-style shell, now wired to real data.
 *
 * KeyboardProvider owns ⌘K (palette) + ⌘J (drawer) and injects `drawerOpen`
 * into its direct AppShell child. We fill the three regions with the live
 * sidebar tree, the session pane (Terminal | Browser | Diff), and the activity
 * sidebar; the bottom drawer hosts a second shell for the selected session.
 * Create dialogs, the settings dialog, and toasts mount alongside.
 */
import { useEffect } from 'react';
import { AppShell } from './AppShell';
import { KeyboardProvider } from './KeyboardProvider';
import { TooltipProvider, Toaster } from '../components/ui';
import { Sidebar } from '../features/paddock/Sidebar';
import { SessionPane } from '../features/paddock/SessionPane';
import { LiveDataProvider } from '../features/paddock/liveData';
import { BottomBar } from '../features/paddock/BottomBar';
import { NodePage } from '../features/paddock/NodePage';
import { PaddockDialogs } from '../features/paddock/PaddockDialogs';
import { SettingsPage } from '../features/settings/SettingsPage';
import { ShellDrawer } from '../features/shell-drawer/ShellDrawer';
import { useSessions } from '../data/queries';
import { usePaddock } from '../store/paddock';

/** The currently-selected session record (from the Query cache), or null. */
function useSelectedSession() {
  const selectedId = usePaddock((s) => s.selectedSessionId);
  const { data: sessions = [] } = useSessions();
  return selectedId ? (sessions.find((x) => x.id === selectedId) ?? null) : null;
}

/**
 * When you land with exactly one open session and nothing chosen, focus it: a
 * grid (or empty grid) of one is pointless. Guarded to a "blank" selection so it
 * NEVER overrides an explicit choice (a picked session/project/node, or an
 * explicit Grid). Closing back down to one session re-focuses it too.
 */
function useAutoFocusSingleSession(): void {
  const { data: sessions = [] } = useSessions();
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  const view = usePaddock((s) => s.view);
  const focusSession = usePaddock((s) => s.focusSession);
  const onlyId = sessions.filter((s) => s.closedAt === null).map((s) => s.id);
  const single = onlyId.length === 1 ? onlyId[0]! : null;
  useEffect(() => {
    if (view === 'paddock' && single && !selectedSessionId && !selectedProjectId && !nodeInfoNodeId) {
      focusSession(single);
    }
  }, [view, single, selectedSessionId, selectedProjectId, nodeInfoNodeId, focusSession]);
}

/** The center region: a node's details when one is open, else the session pane. */
function CenterPane(): JSX.Element {
  const nodeInfoNodeId = usePaddock((s) => s.nodeInfoNodeId);
  return nodeInfoNodeId ? <NodePage /> : <SessionPane />;
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
  useAutoFocusSingleSession();

  return (
    <TooltipProvider delayDuration={300}>
      <KeyboardProvider>
        {view === 'settings' ? (
          <SettingsPage />
        ) : (
          // ONE status WS + agentd-health query shared by sidebar, tabs, and grid.
          <LiveDataProvider>
            <div className="flex h-screen w-screen flex-col overflow-hidden">
              <div className="min-h-0 flex-1">
                <AppShell
                  tree={<Sidebar />}
                  session={<CenterPane />}
                  drawer={<DrawerContent />}
                  treeCollapsed={sidebarCollapsed}
                />
              </div>
              <BottomBar />
            </div>
          </LiveDataProvider>
        )}
        {/* Create dialogs stay mounted so "Add node" works from Settings too. */}
        <PaddockDialogs />
      </KeyboardProvider>
      <Toaster />
    </TooltipProvider>
  );
}
