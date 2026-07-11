import { describe, expect, it, vi } from 'vitest';
import { fetchProjectLayout, putProjectLayout } from './projectLayoutApi';
import { singleSessionLayout } from '@flock/shared';

describe('projectLayoutApi', () => {
  it('fetchProjectLayout parses layout', async () => {
    const layout = singleSessionLayout('p1', 's1');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ layout }), { status: 200 }),
    ) as unknown as typeof fetch;
    const got = await fetchProjectLayout('p1', fetchImpl);
    expect(got?.projectId).toBe('p1');
    expect(got?.focusedLeafId).toBe(layout.focusedLeafId);
  });

  it('putProjectLayout POSTs layout JSON', async () => {
    const layout = singleSessionLayout('p1', 's1');
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(String(init?.body));
      expect(body.projectId).toBe('p1');
      return new Response(JSON.stringify({ layout }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await putProjectLayout(layout, fetchImpl);
    expect(got?.version).toBe(1);
  });
});
