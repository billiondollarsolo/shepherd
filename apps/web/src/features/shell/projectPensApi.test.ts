import { describe, expect, it, vi } from 'vitest';
import { singleSessionLayout, type ProjectPensV1 } from '@flock/shared';
import { fetchProjectPens, putProjectPens } from './projectPensApi';

const pens: ProjectPensV1 = {
  version: 1,
  projectId: 'p1',
  activePenId: 'pen-1',
  pens: [{ id: 'pen-1', name: 'Pen 1', layout: singleSessionLayout('p1', 's1') }],
  independentSessionIds: [],
};

describe('projectPensApi', () => {
  it('reads and writes a multi-Pen document', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ baseRevision: 3, pens });
      }
      return new Response(JSON.stringify({ pens, revision: 4 }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchProjectPens('p1', fetchImpl)).toEqual({ pens, revision: 4 });
    expect(await putProjectPens(pens, 3, fetchImpl)).toEqual({ pens, revision: 4 });
  });
});
