import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Node, Session } from '@flock/shared';
import { usePaddock } from '../../store/paddock';

const nodes: Node[] = [
  makeNode('local', 'Local', 'local', null, 'connected'),
  makeNode('remote', 'Build server', 'ssh', 'gpu', 'disconnected'),
];
const sessions: Session[] = [];

vi.mock('../../data/queries', () => ({
  useNodes: () => ({ data: nodes }),
  useSessions: () => ({ data: sessions }),
}));

vi.mock('../paddock/liveData', () => ({
  useLiveStatuses: () => new Map(),
  useAgentdHealth: () => null,
}));

import { HostChips } from './HostChips';

function makeNode(
  id: string,
  name: string,
  kind: Node['kind'],
  pool: string | null,
  connectionStatus: Node['connectionStatus'],
): Node {
  return {
    id,
    name,
    kind,
    host: kind === 'ssh' ? 'build.internal' : null,
    port: kind === 'ssh' ? 22 : null,
    username: kind === 'ssh' ? 'flock' : null,
    sshAuthMethod: 'key',
    sshHostKey: null,
    pool,
    connectionStatus,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('fleet scope menu', () => {
  beforeEach(() => {
    usePaddock.setState({ hostScope: 'all', nodeOrder: [] });
  });

  it('condenses all hosts and remote nodes into one dropdown', async () => {
    render(<HostChips />);
    const trigger = screen.getByRole('button', { name: 'Fleet scope' });
    expect(trigger).toHaveTextContent('All hosts');
    expect(screen.queryByText('Build server')).toBeNull();

    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
    expect(await screen.findByRole('menuitemradio', { name: 'All hosts' })).toBeChecked();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Build server' }));

    expect(usePaddock.getState().hostScope).toEqual({ nodeId: 'remote' });
    expect(screen.getByRole('button', { name: 'Fleet scope' })).toHaveTextContent('Build server');
  });

  it('offers node pools without adding more header controls', async () => {
    render(<HostChips />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fleet scope' }), {
      key: 'Enter',
      code: 'Enter',
    });

    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Pool: gpu' }));
    expect(usePaddock.getState().hostScope).toEqual({ pool: 'gpu' });
  });
});
