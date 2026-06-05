import { describe, it, expect } from 'vitest';

import { applyTelemetry } from './liveData';
import type { AgentdHealth } from '../../data/treeApi';

describe('applyTelemetry (status-WS telemetry → agentd-health cache)', () => {
  it('seeds a health snapshot when there is none (session treated as live)', () => {
    const out = applyTelemetry(undefined, 's1', { tokens: 1200, tool: 'Edit' });
    expect(out.nodes).toEqual({});
    expect(out.sessions.s1).toEqual({
      live: true,
      tokens: 1200,
      tool: 'Edit',
      model: undefined,
      contextPct: undefined,
      costUsd: undefined,
    });
  });

  it('merges over a session WITHOUT clobbering node link health or other sessions', () => {
    const prev: AgentdHealth = {
      enabled: true,
      nodes: { n1: { link: 'up' } },
      sessions: { s1: { live: true, tokens: 100, model: 'claude' }, s2: { live: false } },
    };
    const out = applyTelemetry(prev, 's1', { tokens: 250, contextPct: 42 });
    expect(out.nodes).toEqual({ n1: { link: 'up' } }); // node health preserved
    expect(out.sessions.s2).toEqual({ live: false }); // untouched
    expect(out.sessions.s1).toEqual({
      live: true, // preserved
      tokens: 250, // updated
      tool: undefined,
      model: 'claude', // preserved (meta didn't carry it)
      contextPct: 42, // updated
      costUsd: undefined,
    });
  });

  it('does not overwrite an existing value with an absent (undefined) meta field', () => {
    const prev: AgentdHealth = { enabled: true, nodes: {}, sessions: { s1: { live: true, model: 'gpt-5' } } };
    const out = applyTelemetry(prev, 's1', { tokens: 5 }); // no model in meta
    expect(out.sessions.s1.model).toBe('gpt-5');
    expect(out.sessions.s1.tokens).toBe(5);
  });

  it('keeps a previously-known live=false until the snapshot reconciles', () => {
    const prev: AgentdHealth = { enabled: true, nodes: {}, sessions: { s1: { live: false } } };
    const out = applyTelemetry(prev, 's1', { tokens: 9 });
    expect(out.sessions.s1.live).toBe(false);
  });
});
