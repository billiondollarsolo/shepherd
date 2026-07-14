import { describe, expect, it } from 'vitest';
import type { AgentdListeningPort } from '../nodes/agentd/protocol.js';
import { associateProjectListeners } from './project-ports-service.js';

function listener(port: number, input: Partial<AgentdListeningPort> = {}): AgentdListeningPort {
  return {
    observationKey: `tcp:${port}`,
    address: '127.0.0.1',
    targetHost: '127.0.0.1',
    port,
    ...input,
  };
}

describe('associateProjectListeners', () => {
  const projects = [
    { id: 'project-a', workingDir: '/work/a' },
    { id: 'project-b', workingDir: '/work/b' },
  ];

  it('prefers authenticated session process ownership over cwd hints', () => {
    const result = associateProjectListeners(
      [listener(3000, { sessionId: 'session-a', cwd: '/work/b' })],
      'project-a',
      projects,
      [{ id: 'session-a', projectId: 'project-a' }],
    );
    expect(result.assigned.map((item) => item.port)).toEqual([3000]);
  });

  it('assigns one cwd descendant and leaves unmatched listeners unassigned', () => {
    const result = associateProjectListeners(
      [listener(3000, { cwd: '/work/a/packages/web' }), listener(8080, { cwd: '/tmp' })],
      'project-a',
      projects,
      [],
    );
    expect(result.assigned.map((item) => item.port)).toEqual([3000]);
    expect(result.unassignedCount).toBe(1);
  });

  it('never guesses when nested project roots make a cwd match ambiguous', () => {
    const result = associateProjectListeners(
      [listener(5173, { cwd: '/work/a/packages/web' })],
      'project-a',
      [...projects, { id: 'project-nested', workingDir: '/work/a/packages' }],
      [],
    );
    expect(result.assigned).toEqual([]);
    expect(result.ambiguousCount).toBe(1);
  });
});
