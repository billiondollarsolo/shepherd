/**
 * Paddock command set (roadmap P9) — turns the command palette from an empty
 * shell into a full navigator + action runner.
 *
 * `buildPaddockCommands` is a PURE function (data + bound store actions → the
 * Command[] the palette shows) so it is unit-testable without React. The
 * `PaddockCommands` component gathers live data + store actions and registers
 * them with the shell (re-registering when the navigable data changes).
 */
import { useEffect, useMemo } from 'react';
import type { Node as FlockNode, Project, Session } from '@flock/shared';
import { useShell } from './KeyboardProvider';
import type { Command } from './commands';
import { usePaddock, type RightTab } from '../store/paddock';
import { useNodes, useProjects, useSessions } from '../data/queries';

/** Store actions the palette commands invoke (all stable zustand setters). */
export interface PaddockCommandActions {
  focusSession: (id: string) => void;
  selectProject: (id: string | null) => void;
  openNodeInfo: (nodeId: string) => void;
  setViewMode: (mode: 'focus' | 'grid') => void;
  toggleGridLayout: () => void;
  toggleSidebar: () => void;
  toggleRight: () => void;
  openRight: (tab: RightTab) => void;
  openSettings: () => void;
  openOverview: () => void;
  openDialog: (kind: 'node' | 'project' | 'session') => void;
}

const RIGHT_TABS: ReadonlyArray<{ tab: RightTab; label: string }> = [
  { tab: 'activity', label: 'Activity' },
  { tab: 'diff', label: 'Source Control' },
  { tab: 'files', label: 'Files' },
  { tab: 'browser', label: 'Browser' },
  { tab: 'search', label: 'Search' },
];

/** A short, stable label for a session row in the palette. */
function sessionLabel(s: Session): string {
  return `${s.agentType} · ${s.id.slice(0, 6)}`;
}

/**
 * Build the full palette command list from live data + bound actions. Order:
 * actions first (create/view/panels/settings), then navigation (sessions →
 * projects → nodes) so a blank query shows "what can I do" before "where".
 */
export function buildPaddockCommands(args: {
  sessions: readonly Session[];
  projects: readonly Project[];
  nodes: readonly FlockNode[];
  actions: PaddockCommandActions;
}): Command[] {
  const { sessions, projects, nodes, actions: a } = args;
  const commands: Command[] = [
    { id: 'new-session', title: 'New session…', hint: 'Create', run: () => a.openDialog('session') },
    { id: 'new-project', title: 'New project…', hint: 'Create', run: () => a.openDialog('project') },
    { id: 'add-node', title: 'Add node…', hint: 'Create', run: () => a.openDialog('node') },

    { id: 'view-grid', title: 'Grid view', hint: 'View', run: () => a.setViewMode('grid') },
    { id: 'view-focus', title: 'Focus view', hint: 'View', run: () => a.setViewMode('focus') },
    { id: 'toggle-grid-layout', title: 'Toggle grid layout (columns / rows)', hint: 'View', run: a.toggleGridLayout },
    { id: 'toggle-sidebar', title: 'Toggle sidebar', hint: 'View', run: a.toggleSidebar },
    { id: 'toggle-right', title: 'Toggle right panel', hint: 'View', run: a.toggleRight },

    ...RIGHT_TABS.map(({ tab, label }) => ({
      id: `open-${tab}`,
      title: `Open ${label}`,
      hint: 'Panel',
      run: () => a.openRight(tab),
    })),

    { id: 'mission-control', title: 'Paddock (all agents)', hint: 'Go', run: a.openOverview },
    { id: 'open-settings', title: 'Open settings', hint: 'Go', run: a.openSettings },
  ];

  // Navigation — only OPEN sessions (closed ones are noise in a "go to" list).
  for (const s of sessions) {
    if (s.closedAt !== null) continue;
    commands.push({
      id: `goto-session-${s.id}`,
      title: `Go to session: ${sessionLabel(s)}`,
      hint: 'Session',
      run: () => a.focusSession(s.id),
    });
  }
  for (const p of projects) {
    commands.push({
      id: `goto-project-${p.id}`,
      title: `Go to project: ${p.name}`,
      hint: 'Project',
      run: () => a.selectProject(p.id),
    });
  }
  for (const n of nodes) {
    commands.push({
      id: `goto-node-${n.id}`,
      title: `Go to node: ${n.name}`,
      hint: 'Node',
      run: () => a.openNodeInfo(n.id),
    });
  }
  return commands;
}

/**
 * Registers the Paddock command set with the shell palette. Mounts inside the
 * KeyboardProvider (for `registerCommands`) and the data providers (for live
 * sessions/projects/nodes). Re-registers when the navigable data changes.
 */
export function PaddockCommands(): null {
  const { registerCommands } = useShell();
  const { data: sessions = [] } = useSessions();
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();

  // Select each action individually — zustand setters are stable references, so
  // this never churns (selecting one new object per render would break the
  // getSnapshot cache). Bundle them once into a stable `actions` object.
  const focusSession = usePaddock((s) => s.focusSession);
  const selectProject = usePaddock((s) => s.selectProject);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const setViewMode = usePaddock((s) => s.setViewMode);
  const toggleGridLayout = usePaddock((s) => s.toggleGridLayout);
  const toggleSidebar = usePaddock((s) => s.toggleSidebar);
  const toggleRight = usePaddock((s) => s.toggleRight);
  const openRight = usePaddock((s) => s.openRight);
  const openSettings = usePaddock((s) => s.openSettings);
  const openOverview = usePaddock((s) => s.openOverview);
  const openDialog = usePaddock((s) => s.openDialog);
  const actions = useMemo<PaddockCommandActions>(
    () => ({
      focusSession, selectProject, openNodeInfo, setViewMode, toggleGridLayout,
      toggleSidebar, toggleRight, openRight, openSettings, openOverview, openDialog,
    }),
    [focusSession, selectProject, openNodeInfo, setViewMode, toggleGridLayout,
      toggleSidebar, toggleRight, openRight, openSettings, openOverview, openDialog],
  );

  const commands = useMemo(
    () => buildPaddockCommands({ sessions, projects, nodes, actions }),
    [sessions, projects, nodes, actions],
  );

  useEffect(() => registerCommands(commands), [registerCommands, commands]);
  return null;
}
