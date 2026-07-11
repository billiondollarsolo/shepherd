/**
 * ResponsivePaddock — desktop paddock shell vs phone Agents stage.
 *
 * Phone uses the same selection store and live terminal transport as desktop.
 */
import { useMemo } from 'react';
import type { Status } from '@flock/shared';
import { Paddock } from '../../app';
import { useNodes, useProjects, useSessions } from '../../data/queries';
import { useStatusWebSocket } from '../tree/useStatusWebSocket';
import { PhoneView, type PhoneSession } from './PhoneView';
import { useIsPhone } from './useIsPhone';
import { PaddockDialogs } from '../paddock/PaddockDialogs';
import { NodePage } from '../paddock/NodePage';
import { ProjectGitPage } from '../paddock/ProjectGitPage';
import { SettingsPage } from '../settings/SettingsPage';
import { usePaddock } from '../../store/paddock';
import { MobileViewportFrame } from './MobileViewportFrame';

export function ResponsivePaddock(): JSX.Element {
  const isPhone = useIsPhone();

  if (!isPhone) {
    return <Paddock />;
  }
  return <PhonePaddock />;
}

function PhonePaddock(): JSX.Element {
  const view = usePaddock((state) => state.view);
  const nodeInfoNodeId = usePaddock((state) => state.nodeInfoNodeId);
  const projectView = usePaddock((state) => state.projectView);
  const { statuses } = useStatusWebSocket();
  const { data: sessions = [] } = useSessions();
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();
  const phoneSessions = useMemo<PhoneSession[]>(
    () => mergePhoneSessions(statuses, sessions, projects, nodes),
    [nodes, projects, sessions, statuses],
  );
  if (view === 'settings') {
    return (
      <MobileViewportFrame testId="phone-settings">
        <SettingsPage />
        <PaddockDialogs />
      </MobileViewportFrame>
    );
  }
  if (nodeInfoNodeId) {
    return (
      <MobileViewportFrame testId="phone-node-details">
        <NodePage />
        <PaddockDialogs />
      </MobileViewportFrame>
    );
  }
  if (projectView === 'git') {
    return (
      <MobileViewportFrame testId="phone-project-git">
        <ProjectGitPage />
        <PaddockDialogs />
      </MobileViewportFrame>
    );
  }
  return (
    <>
      <PhoneView sessions={phoneSessions} nodes={nodes} projects={projects} />
      <PaddockDialogs />
    </>
  );
}

function mergePhoneSessions(
  statuses: ReadonlyMap<string, Status>,
  sessions: ReadonlyArray<{
    id: string;
    agentType: string;
    projectId: string;
    closedAt: string | null;
    status: Status;
    nodeId: string;
  }>,
  projects: ReadonlyArray<{ id: string; name: string; nodeId: string }>,
  nodes: ReadonlyArray<{ id: string; name: string }>,
): PhoneSession[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return sessions
    .filter((session) => !session.closedAt)
    .map((rec) => {
      const project = projectById.get(rec.projectId);
      const node = nodeById.get(rec.nodeId);
      const status: Status = statuses.get(rec.id) ?? rec.status;
      return {
        id: rec.id,
        label: `${rec.agentType} · ${rec.id.slice(0, 6)}`,
        status,
        projectId: rec.projectId,
        projectName: project?.name,
        nodeId: rec.nodeId,
        nodeName: node?.name,
      };
    });
}
