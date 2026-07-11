import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { User } from '@flock/shared';
import { originAllowed, makeWsAuthorizer } from './ws-auth.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const owner: User = {
  id: 'u1',
  username: 'owner',
  createdAt: '',
  lastLoginAt: null,
  isActive: true,
} as User;
const otherOwner: User = { ...owner, id: 'u2', username: 'other-owner' };

describe('originAllowed (T5)', () => {
  const allowed = new Set(['https://flock.example', 'http://100.64.0.42:11010']);

  it('accepts only exact configured browser origins', () => {
    expect(originAllowed(req({ origin: 'https://flock.example' }), allowed)).toBe(true);
    expect(originAllowed(req({ origin: 'http://100.64.0.42:11010' }), allowed)).toBe(true);
    expect(originAllowed(req({ origin: 'https://evil.example' }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: 'https://flock.example:444' }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: 'http://flock.example' }), allowed)).toBe(false);
  });

  it('fails closed for malformed, path-bearing, and unconfigured browser origins', () => {
    expect(originAllowed(req({ origin: 'not a URL' }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: 'https://flock.example/path' }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: 'https://flock.example' }), new Set())).toBe(false);
  });

  it('does not derive trust from Host or proxy headers', () => {
    expect(
      originAllowed(
        req({
          origin: 'https://unconfigured.example',
          host: 'unconfigured.example',
          'x-forwarded-host': 'unconfigured.example',
        }),
        allowed,
      ),
    ).toBe(false);
  });

  it('allows missing Origin for deliberate non-browser clients', () => {
    expect(originAllowed(req({}), allowed)).toBe(true);
  });
});

describe('makeWsAuthorizer (T4)', () => {
  const base = {
    allowedOrigins: new Set(['https://flock.example']),
    resolveUser: async (c: string | undefined) =>
      c === 'other' ? otherOwner : c === 'owner' ? owner : null,
    sessionOwner: async (id: string) => (id === 'owned' ? 'u1' : id === 'other' ? 'u2' : null),
  };
  const auth = makeWsAuthorizer(base);

  it('rejects a bad origin even with a valid cookie', async () => {
    expect(await auth(req({ origin: 'https://evil.example', cookie: 'owner' }), 'owned')).toBe(
      false,
    );
  });
  it('rejects an unauthenticated user', async () => {
    expect(await auth(req({ origin: 'https://flock.example' }), 'owned')).toBe(false);
  });
  it('owner may attach to their own session; non-owner may not', async () => {
    const o = { origin: 'https://flock.example', cookie: 'owner' };
    expect(await auth(req(o), 'owned')).toBe(true);
    expect(await auth(req(o), 'other')).toBe(false);
  });
  it('another authenticated identity does not bypass exact session ownership', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'other' }), 'owned')).toBe(
      false,
    );
  });
  it('unknown or null-owner session fails closed', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'owner' }), 'unknown')).toBe(
      false,
    );
  });
  it('status stream (no sessionId) allows any authed user, rejects anon', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'owner' }))).toBe(true);
    expect(await auth(req({ origin: 'https://flock.example' }))).toBe(false);
  });
});
