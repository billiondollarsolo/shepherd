/**
 * Roadmap F3 — rehydrateStatus unit tests. Verifies the in-memory status map is
 * rebuilt from the persisted mirror after a restart, WITHOUT fanning out a
 * transition or writing the event log (seed semantics).
 */
import { describe, expect, it } from 'vitest';
import type { StatusUpdateMessage } from '@flock/shared';
import { StatusMap } from './map.js';
import { rehydrateStatus } from './rehydrate.js';

describe('rehydrateStatus (F3)', () => {
  it('seeds the map from the mirror, no fan-out', async () => {
    const map = new StatusMap();
    const fanned: StatusUpdateMessage[] = [];
    const unsub = map.subscribe((m) => fanned.push(m));

    const n = await rehydrateStatus(map, async () => [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'awaiting_input' },
    ]);

    expect(n).toBe(2);
    expect(map.get('a')?.status).toBe('running');
    expect(map.get('b')?.status).toBe('awaiting_input');
    expect(fanned).toHaveLength(0); // seed() does not transition/fan-out
    unsub();
  });

  it('is a no-op when there are no open sessions', async () => {
    const map = new StatusMap();
    expect(await rehydrateStatus(map, async () => [])).toBe(0);
    expect(map.snapshot()).toEqual({});
  });

  it('propagates a loader failure to the caller (which logs off the hot path)', async () => {
    const map = new StatusMap();
    await expect(
      rehydrateStatus(map, async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
  });
});
