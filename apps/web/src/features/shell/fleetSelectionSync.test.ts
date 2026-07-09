import { describe, expect, it, vi } from 'vitest';
import {
  hasMeaningfulSelection,
  localPayloadFromSlice,
  remoteToStorePatch,
  runFleetSelectionTick,
  selectionFingerprint,
  selectionIdentity,
} from './fleetSelectionSync';

describe('fleetSelectionSync (production path helpers)', () => {
  it('remoteToStorePatch maps activeProjectId → selectedProjectId and lens view', () => {
    const patch = remoteToStorePatch({
      selectedSessionId: 's1',
      activeProjectId: 'p1',
      hostScope: 'all',
      lens: 'agents',
      updatedAt: '2026-07-09T00:00:00.000Z',
    });
    expect(patch.selectedSessionId).toBe('s1');
    expect(patch.selectedProjectId).toBe('p1');
    expect(patch.lens).toBe('agents');
    expect(patch.view).toBe('paddock');
  });

  it('localPayloadFromSlice stamps selection for PUT', () => {
    const p = localPayloadFromSlice({
      selectedSessionId: 'a',
      selectedProjectId: 'b',
      hostScope: { nodeId: 'n1' },
      lens: 'agents',
      fleetSelectionFollow: true,
    });
    expect(p.selectedSessionId).toBe('a');
    expect(p.activeProjectId).toBe('b');
    expect(p.hostScope).toEqual({ nodeId: 'n1' });
    expect(p.updatedAt).toMatch(/^\d{4}-/);
  });

  it('cold start: empty local + remote s1@older → apply remote, MUST NOT PUT empty', async () => {
    const puts: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ selection: JSON.parse(String(init.body)) }), {
          status: 200,
        });
      }
      // GET: first client's selection, older timestamp than "now" local would stamp
      return new Response(
        JSON.stringify({
          selection: {
            selectedSessionId: 's1',
            activeProjectId: 'p1',
            lens: 'agents',
            hostScope: 'all',
            updatedAt: '2020-01-01T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runFleetSelectionTick({
      slice: {
        selectedSessionId: null,
        selectedProjectId: null,
        hostScope: 'all',
        lens: 'mission',
        fleetSelectionFollow: true,
      },
      lastSyncedKey: null,
      lastWrittenKey: null,
      fetchImpl,
    });

    expect(puts).toEqual([]);
    expect(result.wrote).toBe(false);
    expect(result.puts).toEqual([]);
    expect(result.apply?.selectedSessionId).toBe('s1');
    expect(result.apply?.selectedProjectId).toBe('p1');
    expect(result.writeKey).toBe(
      selectionIdentity({
        selectedSessionId: 's1',
        activeProjectId: 'p1',
        hostScope: 'all',
        lens: 'agents',
      }),
    );
  });

  it('cold start follow-off: empty local + remote s1 → no PUT wipe, no apply', async () => {
    const puts: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ selection: JSON.parse(String(init.body)) }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          selection: {
            selectedSessionId: 's1',
            activeProjectId: null,
            updatedAt: '2020-01-01T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runFleetSelectionTick({
      slice: {
        selectedSessionId: null,
        selectedProjectId: null,
        hostScope: 'all',
        lens: 'mission',
        fleetSelectionFollow: false,
      },
      lastSyncedKey: null,
      fetchImpl,
    });

    expect(puts).toEqual([]);
    expect(result.apply).toBeNull();
    expect(result.wrote).toBe(false);
  });

  it('steady state: local identity change vs lastSyncedKey → PUT', async () => {
    const puts: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ selection: JSON.parse(String(init.body)) }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ selection: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const prevKey = selectionIdentity({
      selectedSessionId: 'old',
      activeProjectId: null,
      hostScope: 'all',
      lens: 'agents',
    });

    const result = await runFleetSelectionTick({
      slice: {
        selectedSessionId: 'new-s',
        selectedProjectId: null,
        hostScope: 'all',
        lens: 'agents',
        fleetSelectionFollow: true,
      },
      lastSyncedKey: prevKey,
      fetchImpl,
    });

    expect(result.wrote).toBe(true);
    expect(puts).toHaveLength(1);
    expect((puts[0] as { selectedSessionId: string }).selectedSessionId).toBe('new-s');
  });

  it('steady state: no local change → no PUT; remote newer applies when follow on', async () => {
    const puts: unknown[] = [];
    const synced = selectionIdentity({
      selectedSessionId: 'local-s',
      activeProjectId: 'local-p',
      hostScope: 'all',
      lens: 'agents',
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ selection: JSON.parse(String(init.body)) }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          selection: {
            selectedSessionId: 'remote-s',
            activeProjectId: 'remote-p',
            lens: 'agents',
            hostScope: 'all',
            updatedAt: '2099-01-01T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runFleetSelectionTick({
      slice: {
        selectedSessionId: 'local-s',
        selectedProjectId: 'local-p',
        hostScope: 'all',
        lens: 'agents',
        fleetSelectionFollow: true,
      },
      lastSyncedKey: synced,
      fetchImpl,
    });

    expect(puts).toEqual([]);
    expect(result.wrote).toBe(false);
    expect(result.apply?.selectedSessionId).toBe('remote-s');
  });

  it('follow disabled: does not apply remote in steady state', async () => {
    const synced = selectionIdentity({
      selectedSessionId: 'local-s',
      activeProjectId: null,
      hostScope: 'all',
      lens: 'agents',
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ selection: JSON.parse(String(init.body)) }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          selection: {
            selectedSessionId: 'remote-s',
            activeProjectId: null,
            updatedAt: '2099-01-01T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runFleetSelectionTick({
      slice: {
        selectedSessionId: 'local-s',
        selectedProjectId: null,
        hostScope: 'all',
        lens: 'agents',
        fleetSelectionFollow: false,
      },
      lastSyncedKey: synced,
      fetchImpl,
    });
    expect(result.apply).toBeNull();
    expect(result.wrote).toBe(false);
  });

  it('hasMeaningfulSelection is false for empty home', () => {
    expect(hasMeaningfulSelection({ selectedSessionId: null, selectedProjectId: null })).toBe(false);
    expect(hasMeaningfulSelection({ selectedSessionId: 's1', selectedProjectId: null })).toBe(true);
  });

  it('selectionFingerprint is stable for identical payloads', () => {
    const a = {
      selectedSessionId: 's',
      activeProjectId: null,
      updatedAt: 't',
      lens: 'agents' as const,
    };
    expect(selectionFingerprint(a)).toBe(selectionFingerprint({ ...a }));
  });
});
