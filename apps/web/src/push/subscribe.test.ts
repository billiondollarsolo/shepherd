/**
 * US-22 — web client Web Push subscribe flow (spec §8.1; FR-ST4, FR-UI6).
 *
 * The acceptance criterion's "web test for the SW registration": assert the
 * service worker is registered at the root scope, and that the subscribe flow
 * POSTs the W3C PushSubscription JSON to `/api/push/subscribe`. Runs in jsdom
 * with mocked `navigator.serviceWorker`, `Notification`, and `fetch`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_WORKER_URL,
  enablePush,
  isPushSupported,
  isServiceWorkerSupported,
  registerServiceWorker,
  sendSubscriptionToServer,
  urlBase64ToUint8Array,
} from './subscribe.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('registerServiceWorker (US-22 SW registration)', () => {
  it('registers /sw.js at the root scope when supported', async () => {
    const fakeRegistration = {} as ServiceWorkerRegistration;
    const register = vi.fn(async () => fakeRegistration);
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    const reg = await registerServiceWorker();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/' });
    expect(SERVICE_WORKER_URL).toBe('/sw.js');
    expect(reg).toBe(fakeRegistration);
  });

  it('returns null (no throw) when service workers are unsupported', async () => {
    vi.stubGlobal('navigator', {});
    expect(isServiceWorkerSupported()).toBe(false);
    await expect(registerServiceWorker()).resolves.toBeNull();
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to bytes', () => {
    // "AQID" base64 => [1, 2, 3]
    const bytes = urlBase64ToUint8Array('AQID');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});

describe('sendSubscriptionToServer', () => {
  it('POSTs the PushSubscription JSON to /api/push/subscribe', async () => {
    const subJson = {
      endpoint: 'https://push.example/aaa',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const subscription = {
      toJSON: () => subJson,
    } as unknown as PushSubscription;

    const fetchMock = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await sendSubscriptionToServer(subscription);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(subJson);
  });

  it('throws on a non-OK response', async () => {
    const subscription = {
      toJSON: () => ({ endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } }),
    } as unknown as PushSubscription;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    );

    await expect(sendSubscriptionToServer(subscription)).rejects.toThrow();
  });
});

describe('enablePush (full enrollment flow)', () => {
  function setupSupported(opts: {
    permission?: NotificationPermission;
    existing?: PushSubscription | null;
  }): {
    register: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    fetchMock: ReturnType<typeof vi.fn>;
  } {
    const subJson = {
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const newSub = { toJSON: () => subJson } as unknown as PushSubscription;
    const subscribe = vi.fn(async () => newSub);
    const getSubscription = vi.fn(async () => opts.existing ?? null);
    const registration = {
      pushManager: { subscribe, getSubscription },
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);

    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('window', { PushManager: function () {} });
    vi.stubGlobal('Notification', {
      requestPermission: vi.fn(async () => opts.permission ?? 'granted'),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/push/vapid-public-key') {
        return { ok: true, json: async () => ({ publicKey: 'AQID' }) } as Response;
      }
      return { ok: true, status: 201 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    return { register, subscribe, fetchMock };
  }

  it('registers the SW, subscribes, and posts the subscription on success', async () => {
    const { register, subscribe, fetchMock } = setupSupported({});

    const result = await enablePush();

    expect(result).toEqual({ ok: true });
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/' });
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns { ok: false, reason: "unsupported" } when push is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', {});
    expect(isPushSupported()).toBe(false);
    expect(await enablePush()).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('returns { ok: false, reason: "denied" } when permission is refused', async () => {
    setupSupported({ permission: 'denied' });
    expect(await enablePush()).toEqual({ ok: false, reason: 'denied' });
  });

  it('reuses an existing subscription instead of re-subscribing', async () => {
    const existing = {
      toJSON: () => ({ endpoint: 'https://push.example/old', keys: { p256dh: 'p', auth: 'a' } }),
    } as unknown as PushSubscription;
    const { subscribe } = setupSupported({ existing });

    const result = await enablePush();

    expect(result).toEqual({ ok: true });
    expect(subscribe).not.toHaveBeenCalled();
  });
});
