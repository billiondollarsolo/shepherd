import { beforeEach, describe, expect, it } from 'vitest';
import { usePaddock } from '../../store/paddock';

describe('Paddock and Agents workspace navigation', () => {
  beforeEach(() => {
    usePaddock.setState({
      view: 'paddock',
      lens: 'agents',
      selectedSessionId: 'session-1',
      selectedProjectId: 'project-1',
      nodeInfoNodeId: 'node-1',
      hostScope: { nodeId: 'node-1' },
      penProjectId: 'project-1',
      zoomLeafId: 'session-1',
    });
  });

  it('opens Paddock as a clean fleet workspace', () => {
    usePaddock.getState().openMission();

    expect(usePaddock.getState()).toMatchObject({
      view: 'overview',
      lens: 'mission',
      selectedSessionId: null,
      selectedProjectId: null,
      nodeInfoNodeId: null,
      hostScope: 'all',
      zoomLeafId: null,
    });
  });

  it('returns from Paddock to the last active Pen project', () => {
    usePaddock.getState().openMission();
    usePaddock.getState().setLens('agents');

    expect(usePaddock.getState()).toMatchObject({
      view: 'paddock',
      lens: 'agents',
      selectedSessionId: null,
      selectedProjectId: 'project-1',
    });
  });

  it('opens Git as a project page without focusing an agent', () => {
    usePaddock.getState().openProjectGit('project-1');

    expect(usePaddock.getState()).toMatchObject({
      selectedProjectId: 'project-1',
      selectedSessionId: null,
      projectView: 'git',
      chrome: 'stage',
      rightOpen: false,
    });
  });
});
