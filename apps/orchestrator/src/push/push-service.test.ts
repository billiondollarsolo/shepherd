/**
 * US-22 — Web Push dispatch service (spec §7 table, §8; FR-ST4, NFR-PERF1).
 *
 * The two acceptance criteria pinned here:
 *   1. Transitions to `awaiting_input` / `done` / `error` SEND a push; every
 *      other transition (`starting`, `running`, `idle`, `disconnected`) sends
 *      NONE (FR-ST4 — the headline US-22 trigger test).
 *   2. The status-map subscription callback does NO inline work (NFR-PERF1): the
 *      load-and-send is deferred off the live path, so a slow/blocked sender can
 *      never delay fan-out.
 * Plus: dead endpoints (404/410 → 'gone') are pruned from the store.
 */
import type { Status, StatusUpdateMessage } from '@flock/shared';
import { STATUS_VALUES } from '@flock/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  PushService,
  type PushNotificationPayload,
  type PushSendResult,
  type StatusTransitionSource,
} from './push-service.js';
import {
  InMemoryPushSubscriptionStore,
  type StoredPushSubscription,
} from './subscription-store.js';

const ISO = '2026-05-29T00:00:00.000Z';

/** A fake status source that lets the test fire transitions on demand. */
function fakeSource(): {
  source: StatusTransitionSource;
  fire: (status: Status, sessionId?: string, detail?: string | null) => void;
} {
  const subs = new Set<(msg: StatusUpdateMessage) => void>();
  const source: StatusTransitionSource = {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  const fire = (
    status: Status,
    sessionId = 'sess-1',
    detail: string | null = null,
  ): void => {
    for (const fn of subs) {
      fn({ channel: 'status', sessionId, status, detail, ts: ISO });
    }
  };
  return { source, fire };
}

function seedSub(over: Partial<StoredPushSubscription> = {}): StoredPushSubscription {
  return {
    userId: 'u1',
    endpoint: 'https://push.example/aaa',
    p256dh: 'p',
    auth: 'a',
    ...over,
  };
}

/** Synchronous defer so the deferred dispatch is awaitable via a flush tick. */
const syncDefer = (fn: () => void): void => {
  fn();
};

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PushService trigger predicate (US-22, FR-ST4)', () => {
  it('sends a push on awaiting_input, done, and error', async () => {
    for (const status of ['awaiting_input', 'done', 'error'] as const) {
      const store = new InMemoryPushSubscriptionStore();
      await store.save(seedSub());
      const sender = vi.fn(async (): Promise<PushSendResult> => 'ok');
      const svc = new PushService({ store, sender, defer: syncDefer });
      const { source, fire } = fakeSource();
      svc.attach(source);

      fire(status);
      await tick();

      expect(sender).toHaveBeenCalledTimes(1);
      const [, payload] = sender.mock.calls[0]! as [
        StoredPushSubscription,
        PushNotificationPayload,
      ];
      expect(payload.status).toBe(status);
      expect(payload.sessionId).toBe('sess-1');
    }
  });

  it('sends NO push on starting, running, idle, or disconnected', async () => {
    for (const status of ['starting', 'running', 'idle', 'disconnected'] as const) {
      const store = new InMemoryPushSubscriptionStore();
      await store.save(seedSub());
      const sender = vi.fn(async (): Promise<PushSendResult> => 'ok');
      const svc = new PushService({ store, sender, defer: syncDefer });
      const { source, fire } = fakeSource();
      svc.attach(source);

      fire(status);
      await tick();

      expect(sender).not.toHaveBeenCalled();
    }
  });

  it('over the FULL enum, sends exactly for the three push-worthy states', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub());
    const sent: Status[] = [];
    const sender = vi.fn(
      async (_sub, payload: PushNotificationPayload): Promise<PushSendResult> => {
        sent.push(payload.status);
        return 'ok';
      },
    );
    const svc = new PushService({ store, sender, defer: syncDefer });
    const { source, fire } = fakeSource();
    svc.attach(source);

    for (const status of STATUS_VALUES) fire(status);
    await tick();

    expect(new Set(sent)).toEqual(new Set(['awaiting_input', 'done', 'error']));
    expect(sent).toHaveLength(3);
  });

  it('fans out to EVERY stored subscription', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub({ endpoint: 'https://push.example/1' }));
    await store.save(seedSub({ endpoint: 'https://push.example/2', userId: 'u2' }));
    const sender = vi.fn(async (): Promise<PushSendResult> => 'ok');
    const svc = new PushService({ store, sender, defer: syncDefer });
    const { source, fire } = fakeSource();
    svc.attach(source);

    fire('awaiting_input');
    await tick();

    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('prunes a dead endpoint (sender returns "gone")', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub({ endpoint: 'https://push.example/dead' }));
    const sender = vi.fn(async (): Promise<PushSendResult> => 'gone');
    const svc = new PushService({ store, sender, defer: syncDefer });
    const { source, fire } = fakeSource();
    svc.attach(source);

    fire('error');
    await tick();

    expect(await store.listAll()).toHaveLength(0);
  });
});

describe('PushService is OFF the live path (NFR-PERF1)', () => {
  it('does no inline work in the status-map callback for a push-worthy state', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub());
    const listAll = vi.spyOn(store, 'listAll');
    const sender = vi.fn(async (): Promise<PushSendResult> => 'ok');

    // The REAL default defer (queueMicrotask): work must not run synchronously.
    const svc = new PushService({ store, sender });
    const { source, fire } = fakeSource();
    svc.attach(source);

    fire('awaiting_input');

    // Synchronously after the transition, the store has NOT been read and the
    // sender has NOT been called — the work was deferred off the live path.
    expect(listAll).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();

    // It does happen, just later.
    await tick();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('a slow/blocked sender never blocks the live transition callback', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub());
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const sender = vi.fn(async (): Promise<PushSendResult> => {
      await blocked;
      return 'ok';
    });
    const svc = new PushService({ store, sender });
    const { source, fire } = fakeSource();
    svc.attach(source);

    const start = performance.now();
    fire('awaiting_input'); // returns immediately despite the wedged sender
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(20);
    release();
  });

  it('after close(), transitions produce no further pushes', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(seedSub());
    const sender = vi.fn(async (): Promise<PushSendResult> => 'ok');
    const svc = new PushService({ store, sender, defer: syncDefer });
    const { source, fire } = fakeSource();
    svc.attach(source);
    svc.close();

    fire('awaiting_input');
    await tick();

    expect(sender).not.toHaveBeenCalled();
  });
});
