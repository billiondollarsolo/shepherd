import { describe, expect, it } from 'vitest';
import {
  effectiveStageProjectId,
  filterSessionsByHostScope,
  shouldUseGridViewAsLayoutFallback,
  stageRenderMode,
} from './stage-scope.js';

describe('effectiveStageProjectId', () => {
  it('when session selected, uses session project not stale project scope', () => {
    expect(
      effectiveStageProjectId({
        selectedSessionId: 's-a',
        selectedProjectId: 'proj-stale',
        selectedSessionProjectId: 'proj-a',
      }),
    ).toBe('proj-a');
  });

  it('when session selected but project unknown, does not fall back to stale scope', () => {
    expect(
      effectiveStageProjectId({
        selectedSessionId: 's-a',
        selectedProjectId: 'proj-stale',
        selectedSessionProjectId: null,
      }),
    ).toBeNull();
  });

  it('when no session, uses selected project', () => {
    expect(
      effectiveStageProjectId({
        selectedSessionId: null,
        selectedProjectId: 'proj-b',
        selectedSessionProjectId: null,
      }),
    ).toBe('proj-b');
  });
});

describe('filterSessionsByHostScope', () => {
  const nodes = [
    { id: 'n1', pool: null },
    { id: 'n2', pool: 'gpu' },
  ];
  const sessions = [
    { id: 'a', nodeId: 'n1', closedAt: null },
    { id: 'b', nodeId: 'n2', closedAt: null },
    { id: 'c', nodeId: 'n1', closedAt: '2026-01-01' },
  ];

  it('all hosts returns open sessions only', () => {
    const got = filterSessionsByHostScope(sessions, 'all', nodes);
    expect(got.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('node scope reduces fleet vs all', () => {
    const scoped = filterSessionsByHostScope(sessions, { nodeId: 'n1' }, nodes);
    expect(scoped.map((s) => s.id)).toEqual(['a']);
    const all = filterSessionsByHostScope(sessions, 'all', nodes);
    expect(scoped.length).toBeLessThan(all.length);
  });
});

describe('stage keep-mount policy', () => {
  it('never uses GridView as layout loading fallback', () => {
    expect(shouldUseGridViewAsLayoutFallback()).toBe(false);
  });

  it('stageRenderMode: loading vs layout vs empty', () => {
    expect(stageRenderMode({ projectId: null, openSessionCount: 0, layoutReady: false })).toBe(
      'empty',
    );
    expect(stageRenderMode({ projectId: 'p', openSessionCount: 2, layoutReady: false })).toBe(
      'loading',
    );
    expect(stageRenderMode({ projectId: 'p', openSessionCount: 2, layoutReady: true })).toBe(
      'layout',
    );
    expect(stageRenderMode({ projectId: 'p', openSessionCount: 0, layoutReady: true })).toBe(
      'empty',
    );
  });
});
