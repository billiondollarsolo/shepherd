/**
 * US-22 — push subscription REST routes (spec §8.1).
 *
 * `POST   /api/push/subscribe` — store the browser's PushSubscription (cookie-
 *                                authed; the subscription is owned by the user).
 * `DELETE /api/push/subscribe` — remove a subscription by endpoint.
 * `GET    /api/push/vapid-public-key` — the VAPID public key the client needs to
 *                                       call `pushManager.subscribe`.
 *
 * Routes are thin: validate with the shared zod contracts, resolve the user from
 * the session cookie (NFR-SEC6 — all API requires auth), and call the store.
 * Storing a subscription is durable but NOT on the live status path; delivery is
 * the push service's job, off the hot path (NFR-PERF1).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { badRequest } from '../http/reply.js';

import {
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  type PushSubscribeResponse,
} from '@flock/shared';

import type { PushSubscriptionStore } from './subscription-store.js';

/**
 * Resolve the authenticated user id from the raw `Cookie` header. Returns the
 * user id when the session cookie is valid, or `null` when the request is
 * unauthenticated — the route maps `null` to 401 (NFR-SEC6). Production wires
 * this to the auth service (load the session, return the user id); tests pass a
 * fake. Kept as a `string | null` contract (rather than throwing) so the route
 * has no cross-module error-class dependency.
 */
export type ResolveUserId = (rawCookie: string | null) => Promise<string | null>;

export interface PushRouteDeps {
  store: PushSubscriptionStore;
  /** Resolve the cookie to a user id, or null when unauthenticated. */
  resolveUserId: ResolveUserId;
  /** The VAPID public key served to the client (base64url). May be empty. */
  vapidPublicKey?: string;
}

function unauthorized(reply: FastifyReply): { error: { code: string; message: string } } {
  void reply.code(401);
  return { error: { code: 'unauthorized', message: 'Not authenticated.' } };
}

/**
 * Register the push routes on the given Fastify instance. The store + auth
 * resolver are injected so tests pass fakes and production passes the Drizzle
 * store + the real auth service.
 */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const { store, resolveUserId, vapidPublicKey } = deps;

  app.post('/api/push/subscribe', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolveUserId(req.headers.cookie ?? null);
    if (!userId) return unauthorized(reply);

    const parsed = PushSubscribeRequest.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, 'Invalid push subscription.');
    }

    const { endpoint, keys } = parsed.data;
    await store.save({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth });

    void reply.code(201);
    const body: PushSubscribeResponse = { ok: true };
    return body;
  });

  app.delete('/api/push/subscribe', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolveUserId(req.headers.cookie ?? null);
    if (!userId) return unauthorized(reply);

    const parsed = PushUnsubscribeRequest.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(reply, 'Invalid unsubscribe payload.');
    }

    await store.removeByEndpoint(parsed.data.endpoint);
    return { ok: true };
  });

  app.get(
    '/api/push/vapid-public-key',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await resolveUserId(req.headers.cookie ?? null);
      if (!userId) return unauthorized(reply);
      return { publicKey: vapidPublicKey ?? '' };
    },
  );
}
