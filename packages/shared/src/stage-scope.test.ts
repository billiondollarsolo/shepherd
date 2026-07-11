import { describe, expect, it } from 'vitest';
import {
  effectiveStageProjectId,
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
