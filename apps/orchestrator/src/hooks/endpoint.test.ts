/**
 * US-15 — Hook endpoint + per-session token auth (spec §8.1, §15; NFR-SEC3).
 *
 * Acceptance (spec §9 US-15):
 *   - `POST /api/hooks/:sessionId` accepts a VALID token (Authorization header),
 *     rejects MISSING/INVALID with 401 (NFR-SEC3); the token is compared against
 *     the session's `hook_token_hash`.
 *
 * Non-negotiables enforced here (spec §15, §8.1 line 187, §10):
 *   - The hot path is DB-FREE: session lookup is the in-memory live binding and
 *     the event write is ENQUEUED (off the live path), never awaited inline. A
 *     test fails if the enqueue sink is touched synchronously.
 *   - Auth is the per-session token in the `Authorization` header, NOT a cookie.
 *   - A hook for an unknown/closed session → 404, with NO map mutation (spec §10).
 *   - On valid token: the in-memory status map is updated + an async event is
 *     enqueued.
 *
 * These are pure unit tests of {@link HookEndpointService}: no Fastify, no DB,
 * no real argon2 (the verifier is injected). Route wiring is covered in
 * `routes.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HookEndpointService,
  HookSessionNotFoundError,
  HookUnauthorizedError,
  extractBearerToken,
  type HookSessionLookup,
  type HookSessionAuth,
} from './endpoint.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const GOOD_TOKEN = 'plaintext-hook-token-abc';
const GOOD_HASH = 'argon2id$hash$for$good$token';

/** In-memory live binding stand-in: only the matching session resolves. */
function lookupFor(id: string, hash: string): HookSessionLookup {
  return {
    getHookAuth(sessionId: string): HookSessionAuth | undefined {
      return sessionId === id
        ? { sessionId, hookTokenHash: hash, agentType: 'claude-code' }
        : undefined;
    },
  };
}

/** Builds a fresh token verifier that matches GOOD_TOKEN<->GOOD_HASH only. */
function makeMatchingVerifier() {
  return vi.fn(async (hash: string, token: string) => {
    return hash === GOOD_HASH && token === GOOD_TOKEN;
  });
}

describe('extractBearerToken (Authorization header parsing)', () => {
  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
  });

  it('parses a Bearer token (case-insensitive scheme)', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('BEARER abc.def')).toBe('abc.def');
  });

  it('accepts a raw token with no scheme (some agents send it bare)', () => {
    expect(extractBearerToken('justthetoken')).toBe('justthetoken');
  });

  it('trims surrounding whitespace', () => {
    expect(extractBearerToken('Bearer    spaced   ')).toBe('spaced');
  });

  it('returns null for a Bearer scheme with no token', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('HookEndpointService.handle (US-15)', () => {
  function build(opts?: {
    onTransition?: ReturnType<typeof vi.fn>;
    enqueueEvent?: ReturnType<typeof vi.fn>;
    verify?: ReturnType<typeof makeMatchingVerifier>;
    lookup?: HookSessionLookup;
  }) {
    const onTransition = opts?.onTransition ?? vi.fn();
    const enqueueEvent = opts?.enqueueEvent ?? vi.fn();
    const verifyToken = opts?.verify ?? makeMatchingVerifier();
    const service = new HookEndpointService({
      lookup: opts?.lookup ?? lookupFor(SESSION_ID, GOOD_HASH),
      verifyToken,
      onTransition,
      enqueueEvent,
    });
    return { service, onTransition, enqueueEvent, verifyToken };
  }

  it('rejects a MISSING token with HookUnauthorizedError (401) and mutates nothing', async () => {
    const { service, onTransition, enqueueEvent } = build();
    await expect(
      service.handle({ sessionId: SESSION_ID, token: null, body: { hook_event_name: 'Stop' } }),
    ).rejects.toBeInstanceOf(HookUnauthorizedError);
    expect(onTransition).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('rejects an INVALID token with HookUnauthorizedError (401) and mutates nothing (NFR-SEC3)', async () => {
    const { service, onTransition, enqueueEvent, verifyToken } = build();
    await expect(
      service.handle({
        sessionId: SESSION_ID,
        token: 'wrong-token',
        body: { hook_event_name: 'Stop' },
      }),
    ).rejects.toBeInstanceOf(HookUnauthorizedError);
    // The token WAS compared against the stored hash (NFR-SEC3).
    expect(verifyToken).toHaveBeenCalledWith(GOOD_HASH, 'wrong-token');
    expect(onTransition).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('rejects an UNKNOWN session with HookSessionNotFoundError (404) and never verifies a token (spec §10)', async () => {
    const verify = makeMatchingVerifier();
    const onTransition = vi.fn();
    const enqueueEvent = vi.fn();
    const service = new HookEndpointService({
      lookup: lookupFor(SESSION_ID, GOOD_HASH),
      verifyToken: verify,
      onTransition,
      enqueueEvent,
    });
    await expect(
      service.handle({
        sessionId: '99999999-9999-4999-8999-999999999999',
        token: GOOD_TOKEN,
        body: { hook_event_name: 'Stop' },
      }),
    ).rejects.toBeInstanceOf(HookSessionNotFoundError);
    // No token comparison for a session that does not exist; no map mutation.
    expect(verify).not.toHaveBeenCalled();
    expect(onTransition).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('accepts a VALID token: verifies against hook_token_hash and acks', async () => {
    const { service, verifyToken } = build();
    const result = await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      body: { hook_event_name: 'Stop' },
    });
    expect(result).toEqual({ ok: true });
    expect(verifyToken).toHaveBeenCalledWith(GOOD_HASH, GOOD_TOKEN);
  });

  it('on a valid hook, updates the in-memory status map (onTransition)', async () => {
    const { service, onTransition } = build();
    await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      // A Claude permission_prompt notification -> awaiting_input.
      body: { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
      agentType: 'claude-code',
    });
    expect(onTransition).toHaveBeenCalledTimes(1);
    const call = onTransition.mock.calls[0]![0] as {
      sessionId: string;
      status: string;
      detail: string | null;
    };
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.status).toBe('awaiting_input');
  });

  it('on a valid hook, ENQUEUES an async event (write-behind, off the live path)', async () => {
    const { service, enqueueEvent } = build();
    const body = { hook_event_name: 'SessionStart' };
    await service.handle({ sessionId: SESSION_ID, token: GOOD_TOKEN, body, agentType: 'claude-code' });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    const evt = enqueueEvent.mock.calls[0]![0] as {
      sessionId: string;
      source: string;
      agentEventRaw: unknown;
    };
    expect(evt.sessionId).toBe(SESSION_ID);
    expect(evt.source).toBe('hook');
    expect(evt.agentEventRaw).toEqual(body);
  });

  it('does NOT block on the event sink: a hung enqueue does not delay the ack (NFR-PERF1)', async () => {
    // An enqueue that never resolves must not stall handle(): enqueue is
    // fire-and-forget, its promise is never awaited on the hot path.
    const enqueueEvent = vi.fn(() => new Promise<void>(() => {}));
    const { service } = build({ enqueueEvent });
    const start = Date.now();
    const result = await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      body: { hook_event_name: 'Stop' },
    });
    expect(result).toEqual({ ok: true });
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('does not crash when the event sink rejects (the DB is a mirror)', async () => {
    const enqueueEvent = vi.fn(() => Promise.reject(new Error('db down')));
    const { service } = build({ enqueueEvent });
    await expect(
      service.handle({ sessionId: SESSION_ID, token: GOOD_TOKEN, body: { hook_event_name: 'Stop' } }),
    ).resolves.toEqual({ ok: true });
    // Drain so an unhandled rejection (if any) would surface in the run.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('still acks (and enqueues) when the payload maps to no status change', async () => {
    // An unrecognized/blank event yields no transition, but the event is still
    // logged so the activity timeline is complete.
    const { service, onTransition, enqueueEvent } = build();
    const result = await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      body: { something: 'unrecognized' },
    });
    expect(result).toEqual({ ok: true });
    expect(onTransition).not.toHaveBeenCalled();
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('uses session agentType from lookup when handle() omits agentType', async () => {
    // Production routes never pass agentType — only the live binding does.
    // Session lookup is configured with agentType: 'claude-code' in build().
    const { service, onTransition } = build();
    await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      body: { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    });
    expect(onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'awaiting_input' }),
    );
  });

  it('appends a `plan` event when the hook carries a TodoWrite (US-34)', async () => {
    const { service, enqueueEvent } = build();
    await service.handle({
      sessionId: SESSION_ID,
      token: GOOD_TOKEN,
      agentType: 'claude-code',
      body: {
        hook_event_name: 'PostToolUse',
        tool_name: 'TodoWrite',
        tool_input: { todos: [{ content: 'do it', status: 'in_progress' }] },
      },
    });
    // Two enqueues: the raw hook event AND the extracted plan snapshot.
    expect(enqueueEvent).toHaveBeenCalledTimes(2);
    const planCall = enqueueEvent.mock.calls
      .map((c) => c[0] as { type?: string; agentEventRaw: unknown })
      .find((e) => e.type === 'plan');
    expect(planCall?.agentEventRaw).toEqual({
      items: [{ content: 'do it', status: 'in_progress' }],
    });
  });
});
