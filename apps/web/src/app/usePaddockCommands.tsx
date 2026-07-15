/**
 * Paddock command set — navigator + action runner for the herdr-aligned shell.
 */
import { useEffect, useMemo } from 'react';
import {
  FolderPlus,
  LayoutGrid,
  PanelRight,
  Server,
  Settings,
  SquareTerminal,
  Terminal,
} from 'lucide-react';
import type { Node as FlockNode, Project, Session } from '@flock/shared';
import { useShell } from './KeyboardProvider';
import type { Command } from './commands';
import { usePaddock, type RightTab } from '../store/paddock';
import { useNodes, useProjects, useSessions } from '../data/queries';

/** Store actions the palette commands invoke (all stable zustand setters). */
export interface PaddockCommandActions {
  openAgent: (id: string, projectId?: string | null) => void;
  selectProject: (id: string | null) => void;
  openProjectPorts: (id: string) => void;
  openNodeInfo: (nodeId: string) => void;
  toggleGridLayout: () => void;
  toggleSidebar: () => void;
  toggleRight: () => void;
  openRight: (tab: RightTab) => void;
  openTools: () => void;
  closeTools: () => void;
  openSettings: () => void;
  openMission: () => void;
  setLens: (lens: 'mission' | 'agents') => void;
  openDialog: (kind: 'node' | 'project' | 'session') => void;
}

const RIGHT_TABS: ReadonlyArray<{ tab: RightTab; label: string }> = [
  { tab: 'activity', label: 'Activity' },
  { tab: 'diff', label: 'Source Control' },
  { tab: 'files', label: 'Files' },
  { tab: 'search', label: 'Search' },
  { tab: 'notes', label: 'Notes' },
];

function sessionLabel(s: Session): string {
  return `${s.agentType} · ${s.id.slice(0, 6)}`;
}

export function buildPaddockCommands(args: {
  sessions: readonly Session[];
  projects: readonly Project[];
  nodes: readonly FlockNode[];
  actions: PaddockCommandActions;
}): Command[] {
  const { sessions, projects, nodes, actions: a } = args;
  const commands: Command[] = [
    {
      id: 'new-session',
      title: 'New session…',
      hint: 'Create',
      icon: SquareTerminal,
      run: () => a.openDialog('session'),
    },
    {
      id: 'new-project',
      title: 'New project…',
      hint: 'Create',
      icon: FolderPlus,
      run: () => a.openDialog('project'),
    },
    {
      id: 'add-node',
      title: 'Add node…',
      hint: 'Create',
      icon: Server,
      run: () => a.openDialog('node'),
    },

    {
      id: 'lens-mission',
      title: 'Paddock',
      hint: 'View',
      icon: LayoutGrid,
      run: () => a.openMission(),
    },
    { id: 'lens-agents', title: 'Agents lens', hint: 'View', run: () => a.setLens('agents') },
    {
      id: 'open-tools',
      title: 'Open tools panel',
      hint: 'View',
      icon: PanelRight,
      run: () => a.openTools(),
    },
    {
      id: 'close-tools',
      title: 'Focus terminals (hide tools)',
      hint: 'View',
      run: () => a.closeTools(),
    },
    {
      id: 'toggle-grid-layout',
      title: 'Toggle grid layout (columns / rows)',
      hint: 'View',
      run: a.toggleGridLayout,
    },
    { id: 'toggle-sidebar', title: 'Toggle sidebar', hint: 'View', run: a.toggleSidebar },
    { id: 'toggle-right', title: 'Toggle right panel', hint: 'View', run: a.toggleRight },

    ...RIGHT_TABS.map(({ tab, label }) => ({
      id: `open-${tab}`,
      title: `Open ${label}`,
      hint: 'Panel',
      run: () => a.openRight(tab),
    })),

    { id: 'mission-control', title: 'Paddock (all agents)', hint: 'Go', run: a.openMission },
    {
      id: 'open-settings',
      title: 'Open settings',
      hint: 'Go',
      icon: Settings,
      run: a.openSettings,
    },
  ];

  for (const s of sessions) {
    if (s.closedAt !== null) continue;
    commands.push({
      id: `goto-session-${s.id}`,
      title: `Go to session: ${sessionLabel(s)}`,
      hint: 'Session',
      icon: Terminal,
      run: () => a.openAgent(s.id, s.projectId),
    });
  }
  for (const p of projects) {
    commands.push({
      id: `goto-project-${p.id}`,
      title: `Go to project: ${p.name}`,
      hint: 'Project',
      run: () => a.selectProject(p.id),
    });
    commands.push({
      id: `goto-project-ports-${p.id}`,
      title: `Open ports: ${p.name}`,
      hint: 'Project',
      run: () => a.openProjectPorts(p.id),
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

export function PaddockCommands(): null {
  const { registerCommands } = useShell();
  const { data: sessions = [] } = useSessions();
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();

  const openAgent = usePaddock((s) => s.openAgent);
  const selectProject = usePaddock((s) => s.selectProject);
  const openProjectPorts = usePaddock((s) => s.openProjectPorts);
  const openNodeInfo = usePaddock((s) => s.openNodeInfo);
  const toggleGridLayout = usePaddock((s) => s.toggleGridLayout);
  const toggleSidebar = usePaddock((s) => s.toggleSidebar);
  const toggleRight = usePaddock((s) => s.toggleRight);
  const openRight = usePaddock((s) => s.openRight);
  const openTools = usePaddock((s) => s.openTools);
  const closeTools = usePaddock((s) => s.closeTools);
  const openSettings = usePaddock((s) => s.openSettings);
  const openMission = usePaddock((s) => s.openMission);
  const setLens = usePaddock((s) => s.setLens);
  const openDialog = usePaddock((s) => s.openDialog);
  const actions = useMemo<PaddockCommandActions>(
    () => ({
      openAgent,
      selectProject,
      openProjectPorts,
      openNodeInfo,
      toggleGridLayout,
      toggleSidebar,
      toggleRight,
      openRight,
      openTools,
      closeTools,
      openSettings,
      openMission,
      setLens,
      openDialog,
    }),
    [
      openAgent,
      selectProject,
      openProjectPorts,
      openNodeInfo,
      toggleGridLayout,
      toggleSidebar,
      toggleRight,
      openRight,
      openTools,
      closeTools,
      openSettings,
      openMission,
      setLens,
      openDialog,
    ],
  );

  const commands = useMemo(
    () => buildPaddockCommands({ sessions, projects, nodes, actions }),
    [sessions, projects, nodes, actions],
  );

  useEffect(() => registerCommands(commands), [registerCommands, commands]);
  return null;
}
