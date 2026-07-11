import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserWorkerClient } from './worker-client';

afterEach(() => vi.unstubAllGlobals());

describe('BrowserWorkerClient', () => {
  it('keeps the capability in a header and mirrors lifecycle state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flock-browser-worker-client-'));
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'worker-capability-that-is-at-least-32-bytes');
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        if (init?.method === 'DELETE') return Response.json({ stopped: true });
        return Response.json({
          sessionId: '11111111-1111-4111-8111-111111111111',
          containerId: 'container',
          cdpEndpoint: 'ws://172.20.0.4:9222/devtools/browser/id',
          startedAt: new Date(0).toISOString(),
        });
      }),
    );
    const client = new BrowserWorkerClient('http://worker:8090', tokenFile);
    const browser = await client.launch('11111111-1111-4111-8111-111111111111');
    expect(client.get(browser.sessionId)).toEqual(browser);
    expect(requests[0]?.url).not.toContain('worker-capability');
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer worker-capability-that-is-at-least-32-bytes',
    });
    expect(await client.stop(browser.sessionId)).toBe(true);
    expect(client.get(browser.sessionId)).toBeUndefined();
  });
});
