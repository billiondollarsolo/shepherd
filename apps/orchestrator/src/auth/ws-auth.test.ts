import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { User } from '@flock/shared';
import { originAllowed, makeWsAuthorizer } from './ws-auth.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const member: User = {
  id: 'u1',
  username: 'm',
  role: 'member',
  createdAt: '',
  lastLoginAt: null,
  isActive: true,
} as User;
const admin: User = { ...member, id: 'a1', role: 'admin' };

describe('originAllowed (T5)', () => {
  it('allows same origin, rejects cross origin, allows missing (non-browser)', () => {
    expect(originAllowed(req({ origin: 'https://flock.example' }), 'https://flock.example')).toBe(
      true,
    );
    expect(originAllowed(req({ origin: 'https://evil.example' }), 'https://flock.example')).toBe(
      false,
    );
    expect(originAllowed(req({}), 'https://flock.example')).toBe(true); // no Origin → curl/etc.
    expect(originAllowed(req({ origin: 'https://evil.example' }), undefined)).toBe(true); // unconfigured → allow
  });

  it('dev bypass: any Origin allowed regardless of PUBLIC_BASE_URL', () => {
    // The Tailscale-IP dev bug: browse host != PUBLIC_BASE_URL must still connect.
    expect(
      originAllowed(req({ origin: 'http://100.64.0.42:5173' }), 'http://localhost:5173', {
        dev: true,
      }),
    ).toBe(true);
  });

  it('same-origin: Origin host matches the request Host (proxy-aware), even if != PUBLIC_BASE_URL', () => {
    expect(
      originAllowed(
        req({ origin: 'https://box.ts.net', host: 'box.ts.net' }),
        'https://flock.example',
      ),
    ).toBe(true);
    // X-Forwarded-Host (behind Caddy) is honored.
    expect(
      originAllowed(
        req({ origin: 'https://box.ts.net', 'x-forwarded-host': 'box.ts.net' }),
        'https://flock.example',
      ),
    ).toBe(true);
    // genuine cross-site (origin host != request host, != PUBLIC_BASE_URL) still rejected
    expect(
      originAllowed(
        req({ origin: 'https://evil.example', host: 'box.ts.net' }),
        'https://flock.example',
      ),
    ).toBe(false);
  });
});

describe('makeWsAuthorizer (T4)', () => {
  const base = {
    allowedOrigin: 'https://flock.example',
    resolveUser: async (c: string | undefined) =>
      c === 'admin' ? admin : c === 'member' ? member : null,
    sessionOwner: async (id: string) => (id === 'owned' ? 'u1' : id === 'other' ? 'u2' : null),
  };
  const auth = makeWsAuthorizer(base);

  it('rejects a bad origin even with a valid cookie', async () => {
    expect(await auth(req({ origin: 'https://evil.example', cookie: 'member' }), 'owned')).toBe(
      false,
    );
  });
  it('rejects an unauthenticated user', async () => {
    expect(await auth(req({ origin: 'https://flock.example' }), 'owned')).toBe(false);
  });
  it('owner may attach to their own session; non-owner may not', async () => {
    const o = { origin: 'https://flock.example', cookie: 'member' };
    expect(await auth(req(o), 'owned')).toBe(true);
    expect(await auth(req(o), 'other')).toBe(false);
  });
  it('admin may attach to any session', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'admin' }), 'other')).toBe(
      true,
    );
  });
  it('legacy session with null owner is allowed for any authed user', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'member' }), 'unknown')).toBe(
      true,
    );
  });
  it('status stream (no sessionId) allows any authed user, rejects anon', async () => {
    expect(await auth(req({ origin: 'https://flock.example', cookie: 'member' }))).toBe(true);
    expect(await auth(req({ origin: 'https://flock.example' }))).toBe(false);
  });
});
