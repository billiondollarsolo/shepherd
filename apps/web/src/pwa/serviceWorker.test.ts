/**
 * US-36 — the service worker is the second half of "installable PWA with service
 * worker" (FR-UI6). It must add an offline app-shell cache (so a launched PWA
 * opens even on a flaky phone connection) WITHOUT regressing the US-22 Web Push
 * handlers — Shepherd ships ONE service worker at `/sw.js` shared by both stories.
 *
 * We load `public/sw.js` into a hand-rolled ServiceWorkerGlobalScope stub and
 * drive the lifecycle/fetch events, so the cache behaviour and the coexistence
 * with push are both pinned. Runs under `pnpm test:unit` (no real SW runtime).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const swPath = resolve(here, '../../public/sw.js');
const swSource = readFileSync(swPath, 'utf8');

/** A tiny in-memory Cache + caches stub good enough to drive the SW. */
class FakeCache {
  store = new Map<string, Response>();
  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.store.set(url, new Response('cached:' + url));
  }
  async put(req: RequestInfo, res: Response): Promise<void> {
    this.store.set(typeof req === 'string' ? req : (req as Request).url, res);
  }
  async match(req: RequestInfo): Promise<Response | undefined> {
    return this.store.get(typeof req === 'string' ? req : (req as Request).url);
  }
}

interface SwScope {
  listeners: Record<string, ((event: unknown) => void) | undefined>;
  addEventListener: (type: string, cb: (event: unknown) => void) => void;
  skipWaiting: ReturnType<typeof vi.fn>;
  clients: { claim: ReturnType<typeof vi.fn> };
  registration: { showNotification: ReturnType<typeof vi.fn> };
  caches: {
    open: (name: string) => Promise<FakeCache>;
    keys: () => Promise<string[]>;
    delete: (name: string) => Promise<boolean>;
    _caches: Map<string, FakeCache>;
  };
  fetch: ReturnType<typeof vi.fn>;
}

function makeScope(): SwScope {
  const cacheMap = new Map<string, FakeCache>();
  const scope: SwScope = {
    listeners: {},
    addEventListener(type, cb) {
      this.listeners[type] = cb;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    caches: {
      _caches: cacheMap,
      async open(name: string) {
        let c = cacheMap.get(name);
        if (!c) {
          c = new FakeCache();
          cacheMap.set(name, c);
        }
        return c;
      },
      async keys() {
        return [...cacheMap.keys()];
      },
      async delete(name: string) {
        return cacheMap.delete(name);
      },
    },
    fetch: vi.fn(() => Promise.resolve(new Response('network'))),
  };
  return scope;
}

/** Evaluate the SW source against a stubbed `self`. */
function loadServiceWorker(scope: SwScope): void {
  // The SW refers to bare `self`; bind it for the eval.
  const fn = new Function('self', 'caches', 'fetch', `${swSource}\n;`);
  fn(scope, scope.caches, scope.fetch);
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('service worker — PWA shell + Web Push coexistence (US-36/US-22)', () => {
  let scope: SwScope;

  beforeEach(() => {
    scope = makeScope();
    loadServiceWorker(scope);
  });

  it('still registers the US-22 push + notificationclick handlers', () => {
    expect(typeof scope.listeners.push).toBe('function');
    expect(typeof scope.listeners.notificationclick).toBe('function');
  });

  it('shows a notification on push (US-22 unbroken)', async () => {
    const event = {
      data: { json: () => ({ title: 'Agent needs you', body: 'awaiting_input', sessionId: 's1' }) },
      waitUntil: (p: Promise<unknown>) => p,
    };
    scope.listeners.push?.(event);
    await flush();
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      'Agent needs you',
      expect.objectContaining({ body: 'awaiting_input' }),
    );
  });

  it('uses Shepherd when a push payload omits its title', async () => {
    const event = {
      data: { json: () => ({ body: 'awaiting_input', sessionId: 's1' }) },
      waitUntil: (p: Promise<unknown>) => p,
    };
    scope.listeners.push?.(event);
    await flush();
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      'Shepherd',
      expect.objectContaining({ body: 'awaiting_input' }),
    );
  });

  it('pre-caches the app shell on install (offline-launchable PWA)', async () => {
    const waited: Promise<unknown>[] = [];
    scope.listeners.install?.({ waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
    // Some cache was opened and the root document was added.
    const allEntries = [...scope.caches._caches.values()].flatMap((c) => [...c.store.keys()]);
    expect(allEntries).toContain('/');
    expect(scope.skipWaiting).toHaveBeenCalled();
  });

  it('drops stale caches on activate', async () => {
    // Seed an old cache version; activate should prune anything that is not the
    // current shell cache.
    scope.caches._caches.set('flock-shell-OLD', new FakeCache());
    const waited: Promise<unknown>[] = [];
    scope.listeners.activate?.({ waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
    expect(scope.caches._caches.has('flock-shell-OLD')).toBe(false);
    expect(scope.clients.claim).toHaveBeenCalled();
  });

  it('serves a navigation from cache when the network is offline', async () => {
    // Prime the shell cache via install.
    const installed: Promise<unknown>[] = [];
    scope.listeners.install?.({ waitUntil: (p: Promise<unknown>) => installed.push(p) });
    await Promise.all(installed);

    // Network down → fetch rejects; the SW must fall back to the cached shell.
    scope.fetch.mockRejectedValueOnce(new Error('offline'));
    let respondedWith: Promise<Response> | undefined;
    const request = {
      method: 'GET',
      mode: 'navigate',
      url: 'https://app/deep/link',
    } as unknown as Request;
    scope.listeners.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => {
        respondedWith = p;
      },
    });
    expect(respondedWith).toBeDefined();
    const responded = await respondedWith!;
    expect(responded).toBeDefined();
    expect(await responded.text()).toContain('cached:/');
  });
});
