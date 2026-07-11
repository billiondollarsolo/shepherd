import { readFileSync } from 'node:fs';
import type { BrowserLifecycle } from './lifecycle.js';
import type { SessionBrowser } from './layerA/index.js';

interface WorkerBrowser {
  sessionId: string;
  containerId: string;
  cdpEndpoint: string;
  startedAt: string;
}

export class BrowserWorkerClient implements BrowserLifecycle {
  private readonly browsers = new Map<string, SessionBrowser>();
  private readonly token: string;

  constructor(
    private readonly baseUrl: string,
    tokenFile: string,
  ) {
    this.token = readFileSync(tokenFile, 'utf8').trim();
    if (this.token.length < 32) throw new Error('browser worker token must be at least 32 bytes');
  }

  get(sessionId: string): SessionBrowser | undefined {
    return this.browsers.get(sessionId);
  }

  async launch(sessionId: string): Promise<SessionBrowser> {
    const response = await this.request<WorkerBrowser>('POST', '/v1/browsers', { sessionId });
    const browser = { ...response, startedAt: new Date(response.startedAt) };
    this.browsers.set(sessionId, browser);
    return browser;
  }

  async stop(sessionId: string): Promise<boolean> {
    const result = await this.request<{ stopped: boolean }>(
      'DELETE',
      `/v1/browsers/${encodeURIComponent(sessionId)}`,
    );
    this.browsers.delete(sessionId);
    return result.stopped;
  }

  async reap(): Promise<string[]> {
    const result = await this.request<{ removed: string[] }>('POST', '/v1/reap');
    return result.removed;
  }

  async stopAll(): Promise<void> {
    await this.request('POST', '/v1/stop-all');
    this.browsers.clear();
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`browser worker ${method} ${path} failed (${response.status})`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
}
