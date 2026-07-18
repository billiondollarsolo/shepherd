import { describe, it, expect } from 'vitest';
import type { Event, Session } from '@flock/shared';

import {
  buildStatusTimeline,
  buildSessionMetadata,
  formatTimelineTimestamp,
} from './activityModel';

/**
 * US-34 / FR-UI5 — the right activity sidebar's view-model.
 *
 * Pure functions over the SHARED `@flock/shared` `Event` / `Session` domain
 * types (no duplicated types). They feed the presentational `ActivitySidebar`:
 *   - a status TIMELINE derived from events,
 *   - session METADATA,
 *   - ARTIFACT placeholders structured for the Phase-2 supervisor to fill.
 */

const SESSION: Session = {
  id: '11111111-1111-1111-1111-111111111111',
  nodeId: '22222222-2222-2222-2222-222222222222',
  projectId: '33333333-3333-3333-3333-333333333333',
  agentType: 'claude-code',
  tmuxSessionName: 'flock-sess-1',
  workingDir: '/home/dev/project',
  hookTokenHash: 'super-secret-hash',
  status: 'awaiting_input',
  statusDetail: 'Approve edit to src/app.ts?',
  createdAt: '2026-05-29T09:00:00.000Z',
  lastStatusAt: '2026-05-29T09:05:00.000Z',
  createdBy: '44444444-4444-4444-4444-444444444444',
  closedAt: null,
};

function evt(partial: Partial<Event> & Pick<Event, 'id' | 'ts'>): Event {
  return {
    sessionId: SESSION.id,
    type: 'status',
    source: 'hook',
    agentEventRaw: null,
    mappedStatus: 'running',
    detail: null,
    ...partial,
  };
}

describe('buildStatusTimeline (US-34, status timeline from events)', () => {
  it('keeps only status-bearing events (mappedStatus !== null)', () => {
    const events: Event[] = [
      evt({ id: 'a', ts: '2026-05-29T09:01:00.000Z', mappedStatus: 'running' }),
      evt({ id: 'b', ts: '2026-05-29T09:02:00.000Z', mappedStatus: null, type: 'tool' }),
      evt({ id: 'c', ts: '2026-05-29T09:03:00.000Z', mappedStatus: 'awaiting_input' }),
    ];
    const timeline = buildStatusTimeline(events);
    expect(timeline.map((e) => e.id)).toEqual(['c', 'a']);
    expect(timeline.every((e) => e.status !== null)).toBe(true);
  });

  it('orders the timeline newest-first', () => {
    const events: Event[] = [
      evt({ id: 'old', ts: '2026-05-29T09:00:00.000Z', mappedStatus: 'starting' }),
      evt({ id: 'new', ts: '2026-05-29T09:10:00.000Z', mappedStatus: 'running' }),
      evt({ id: 'mid', ts: '2026-05-29T09:05:00.000Z', mappedStatus: 'idle' }),
    ];
    expect(buildStatusTimeline(events).map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('carries the mapped status, source and detail onto each entry', () => {
    const events: Event[] = [
      evt({
        id: 'a',
        ts: '2026-05-29T09:05:00.000Z',
        mappedStatus: 'awaiting_input',
        source: 'hook',
        detail: 'Approve edit?',
      }),
    ];
    const [entry] = buildStatusTimeline(events);
    expect(entry).toMatchObject({
      id: 'a',
      status: 'awaiting_input',
      source: 'hook',
      detail: 'Approve edit?',
      ts: '2026-05-29T09:05:00.000Z',
    });
  });

  it('drops internal OSC-fallback heuristic transitions (osc:* detail)', () => {
    const events: Event[] = [
      evt({ id: 'real', ts: '2026-05-29T09:01:00.000Z', mappedStatus: 'running', detail: null }),
      evt({
        id: 'osc1',
        ts: '2026-05-29T09:02:00.000Z',
        mappedStatus: 'idle',
        detail: 'osc:output-quiet',
      }),
      evt({
        id: 'osc2',
        ts: '2026-05-29T09:03:00.000Z',
        mappedStatus: 'running',
        detail: 'osc:output-resumed',
      }),
      evt({
        id: 'real2',
        ts: '2026-05-29T09:04:00.000Z',
        mappedStatus: 'awaiting_input',
        detail: 'Approve edit?',
      }),
    ];
    // Only the genuine (hook/transcript) transitions survive — no osc:* noise.
    expect(buildStatusTimeline(events).map((e) => e.id)).toEqual(['real2', 'real']);
  });

  it('returns an empty timeline for no events', () => {
    expect(buildStatusTimeline([])).toEqual([]);
  });

  it('caps the timeline at the requested limit (most recent kept)', () => {
    // Alternate statuses so each is a distinct transition (consecutive same-status
    // events collapse — see the dedup test below).
    const events: Event[] = Array.from({ length: 10 }, (_, i) =>
      evt({
        id: `e${i}`,
        ts: `2026-05-29T09:0${i}:00.000Z`,
        mappedStatus: i % 2 === 0 ? 'running' : 'idle',
      }),
    );
    const timeline = buildStatusTimeline(events, 3);
    expect(timeline).toHaveLength(3);
    expect(timeline.map((e) => e.id)).toEqual(['e9', 'e8', 'e7']);
  });

  it('collapses consecutive same-status echoes into a single transition', () => {
    // The pipeline records the same milestone multiple times: a raw hook row + its
    // derived orchestrator transition, repeated PreToolUse/PostToolUse, and the
    // transcript watcher's echoes. A status timeline keeps one row per transition.
    const events: Event[] = [
      evt({
        id: 's1',
        ts: '2026-05-29T09:00:01.000Z',
        mappedStatus: 'starting',
        source: 'orchestrator',
      }),
      evt({ id: 's2', ts: '2026-05-29T09:00:02.000Z', mappedStatus: 'starting', source: 'hook' }),
      evt({
        id: 'r1',
        ts: '2026-05-29T09:00:03.000Z',
        mappedStatus: 'running',
        source: 'hook',
        detail: 'Bash',
      }),
      evt({
        id: 'r2',
        ts: '2026-05-29T09:00:04.000Z',
        mappedStatus: 'running',
        source: 'orchestrator',
        detail: 'Bash',
      }),
      evt({
        id: 'r3',
        ts: '2026-05-29T09:00:05.000Z',
        mappedStatus: 'running',
        source: 'orchestrator',
        detail: 'Bash: echo hi',
      }),
      evt({ id: 'd1', ts: '2026-05-29T09:00:06.000Z', mappedStatus: 'done', source: 'hook' }),
      evt({
        id: 'd2',
        ts: '2026-05-29T09:00:07.000Z',
        mappedStatus: 'done',
        source: 'orchestrator',
      }),
    ];
    const timeline = buildStatusTimeline(events);
    // One entry per transition, newest-first.
    expect(timeline.map((e) => e.status)).toEqual(['done', 'running', 'starting']);
    // Each run keeps its START event (earliest in the run).
    expect(timeline.map((e) => e.id)).toEqual(['d1', 'r1', 's1']);
    // The running run adopts the most specific detail seen in it.
    expect(timeline.find((e) => e.status === 'running')?.detail).toBe('Bash: echo hi');
  });

  it('suppresses a brief running⇄idle flap (PTY activity heuristic)', () => {
    const events: Event[] = [
      evt({ id: 'r1', ts: '2026-05-29T09:00:00.000Z', mappedStatus: 'running', detail: 'Bash' }),
      evt({ id: 'i1', ts: '2026-05-29T09:00:02.000Z', mappedStatus: 'idle' }), // 2s blip → flap
      evt({
        id: 'r2',
        ts: '2026-05-29T09:00:03.000Z',
        mappedStatus: 'running',
        detail: 'Edit file',
      }),
    ];
    const timeline = buildStatusTimeline(events);
    expect(timeline.map((e) => e.status)).toEqual(['running']); // one continuous run
    expect(timeline[0]?.id).toBe('r1'); // run start preserved
    expect(timeline[0]?.detail).toBe('Edit file'); // richer detail merged across the flap
  });

  it('keeps a sustained idle (a real pause is not a flap)', () => {
    const events: Event[] = [
      evt({ id: 'r1', ts: '2026-05-29T09:00:00.000Z', mappedStatus: 'running' }),
      evt({ id: 'i1', ts: '2026-05-29T09:00:10.000Z', mappedStatus: 'idle' }), // 10s ≥ 4s window
      evt({ id: 'r2', ts: '2026-05-29T09:00:20.000Z', mappedStatus: 'running' }),
    ];
    expect(buildStatusTimeline(events).map((e) => e.status)).toEqual([
      'running',
      'idle',
      'running',
    ]);
  });

  it('never suppresses a brief awaiting_input (the money state)', () => {
    const events: Event[] = [
      evt({ id: 'r1', ts: '2026-05-29T09:00:00.000Z', mappedStatus: 'running' }),
      evt({ id: 'a1', ts: '2026-05-29T09:00:01.000Z', mappedStatus: 'awaiting_input' }), // 1s, but kept
      evt({ id: 'r2', ts: '2026-05-29T09:00:02.000Z', mappedStatus: 'running' }),
    ];
    expect(buildStatusTimeline(events).map((e) => e.status)).toEqual([
      'running',
      'awaiting_input',
      'running',
    ]);
  });
});

describe('buildSessionMetadata (US-34, session metadata)', () => {
  it('projects the shared Session into a labelled metadata view-model', () => {
    const meta = buildSessionMetadata(SESSION);
    const byKey = Object.fromEntries(meta.map((m) => [m.key, m.value]));
    expect(byKey.agentType).toBe('claude-code');
    expect(byKey.status).toBe('awaiting_input');
    expect(byKey.workingDir).toBe('/home/dev/project');
    expect(byKey.sessionId).toBe(SESSION.id);
  });

  it('gives every metadata row a human-readable label', () => {
    const meta = buildSessionMetadata(SESSION);
    expect(meta.length).toBeGreaterThan(0);
    for (const row of meta) {
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it('never surfaces the hook token hash (secret material)', () => {
    const meta = buildSessionMetadata(SESSION);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(SESSION.hookTokenHash);
    expect(meta.some((m) => m.key === 'hookTokenHash')).toBe(false);
  });
});

describe('formatTimelineTimestamp', () => {
  it('renders an ISO timestamp as a short, non-empty time label', () => {
    expect(formatTimelineTimestamp('2026-05-29T09:05:00.000Z')).toMatch(/\d/);
  });
});
