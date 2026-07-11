import { describe, expect, it, vi } from 'vitest';
import {
  fetchFleetSelection,
  putFleetSelection,
  resolveRemoteSelection,
  selectionFromStore,
} from './fleetSelectionClient';

describe('fleetSelectionClient', () => {
  it('fetchFleetSelection parses server body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            selection: {
              selectedSessionId: 's1',
              activeProjectId: 'p1',
              updatedAt: '2026-07-09T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sel = await fetchFleetSelection(fetchImpl);
    expect(sel?.selectedSessionId).toBe('s1');
  });

  it('putFleetSelection sends body and returns selection', async () => {
    const payload = {
      selectedSessionId: 's2',
      activeProjectId: null,
      updatedAt: '2026-07-09T01:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(String(init?.body));
      expect(body.selectedSessionId).toBe('s2');
      return new Response(JSON.stringify({ selection: payload }), { status: 200 });
    }) as unknown as typeof fetch;
    const sel = await putFleetSelection(payload, fetchImpl);
    expect(sel?.selectedSessionId).toBe('s2');
  });

  it('resolveRemoteSelection respects follow + LWW', () => {
    const local = {
      selectedSessionId: 'a',
      activeProjectId: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const remote = {
      selectedSessionId: 'b',
      activeProjectId: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    expect(resolveRemoteSelection(false, local, remote)).toBeNull();
    expect(resolveRemoteSelection(true, local, remote)?.selectedSessionId).toBe('b');
  });

  it('selectionFromStore stamps updatedAt', () => {
    const s = selectionFromStore({
      selectedSessionId: 'x',
      selectedProjectId: 'y',
      lens: 'agents',
    });
    expect(s.selectedSessionId).toBe('x');
    expect(s.activeProjectId).toBe('y');
    expect(s.updatedAt).toMatch(/^\d{4}-/);
  });
});
