import { describe, expect, it } from 'vitest';

import { describeOriginPolicy, parseExactOrigin, readOriginPolicy } from './origin-policy.js';

describe('parseExactOrigin', () => {
  it.each([
    'https://flock.example',
    'https://flock.example:8443',
    'http://localhost:5173',
    'http://100.64.0.42:11010',
  ])('accepts canonical exact origin %s', (origin) => {
    expect(parseExactOrigin(origin, 'test')).toBe(origin);
  });

  it.each([
    'https://flock.example/',
    'https://flock.example/path',
    'https://user@flock.example',
    'https://*.example.com',
    'wss://flock.example',
    'javascript:alert(1)',
    'not a url',
  ])('rejects non-exact or unsafe value %s', (origin) => {
    expect(() => parseExactOrigin(origin, 'test')).toThrow();
  });
});

describe('readOriginPolicy', () => {
  it('requires an explicit public URL and allowlist in production', () => {
    expect(() => readOriginPolicy({ NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() =>
      readOriginPolicy({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://flock.example' }),
    ).toThrow(/FLOCK_ALLOWED_ORIGINS/);
  });

  it('requires the production allowlist to include the public URL', () => {
    expect(() =>
      readOriginPolicy({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://flock.example',
        FLOCK_ALLOWED_ORIGINS: 'https://other.example',
      }),
    ).toThrow(/include PUBLIC_BASE_URL/);
  });

  it('rejects plaintext production unless the private mode is explicitly acknowledged', () => {
    expect(() =>
      readOriginPolicy({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://flock.example',
        FLOCK_ALLOWED_ORIGINS: 'http://flock.example',
      }),
    ).toThrow(/PUBLIC_BASE_URL must use https/);

    expect(() =>
      readOriginPolicy({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://flock.example',
        FLOCK_ALLOWED_ORIGINS: 'https://flock.example,http://tailnet-host:11010',
      }),
    ).toThrow(/every FLOCK_ALLOWED_ORIGINS entry must use https/);

    expect(() =>
      readOriginPolicy({
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'private-http',
        PUBLIC_BASE_URL: 'http://flock.example',
        FLOCK_ALLOWED_ORIGINS: 'http://flock.example',
      }),
    ).toThrow(/FLOCK_ALLOW_INSECURE_HTTP=1/);

    expect(() =>
      readOriginPolicy({
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'builtin-tls',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
        PUBLIC_BASE_URL: 'https://flock.example',
        FLOCK_ALLOWED_ORIGINS: 'https://flock.example',
      }),
    ).toThrow(/valid only.*private-http/);
  });

  it('accepts an explicitly acknowledged private HTTP deployment', () => {
    const policy = readOriginPolicy({
      NODE_ENV: 'production',
      FLOCK_DEPLOYMENT_MODE: 'private-http',
      FLOCK_ALLOW_INSECURE_HTTP: '1',
      PUBLIC_BASE_URL: 'http://100.64.0.42:11010',
      FLOCK_ALLOWED_ORIGINS: 'http://100.64.0.42:11010',
    });
    expect(policy.deployment).toEqual({
      mode: 'private-http',
      transport: 'http',
      warning: 'Private HTTP mode — traffic is not encrypted. Use only on a trusted LAN or VPN.',
    });
  });

  it('parses and deduplicates exact production origins', () => {
    const policy = readOriginPolicy({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://flock.example',
      FLOCK_ALLOWED_ORIGINS: 'https://flock.example,https://box.example:8443',
    });
    expect(policy.mode).toBe('production');
    expect(policy.deployment).toEqual({
      mode: 'builtin-tls',
      transport: 'https',
      warning: null,
    });
    expect([...policy.allowedOrigins]).toEqual([
      'https://flock.example',
      'https://box.example:8443',
    ]);
  });

  it('uses narrow localhost defaults in development and adds explicit origins', () => {
    const policy = readOriginPolicy({
      PUBLIC_BASE_URL: 'http://localhost:11010',
      FLOCK_ALLOWED_ORIGINS: 'http://100.64.0.42:11010',
    });
    expect([...policy.allowedOrigins]).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://100.64.0.42:11010',
      'http://localhost:11010',
    ]);
  });

  it('never treats insecure cookie transport as an Origin bypass', () => {
    const policy = readOriginPolicy({
      FLOCK_ALLOW_INSECURE_HTTP: '1',
      FLOCK_ALLOWED_ORIGINS: 'http://localhost:11010',
    });
    expect(policy.allowedOrigins.has('https://evil.example')).toBe(false);
  });

  it('rejects malformed lists and emits a secret-free summary', () => {
    expect(() => readOriginPolicy({ FLOCK_ALLOWED_ORIGINS: 'http://localhost:5173,' })).toThrow(
      /empty entry/,
    );
    const policy = readOriginPolicy({ FLOCK_ALLOWED_ORIGINS: 'http://localhost:11010' });
    expect(describeOriginPolicy(policy)).toBe(
      '[security] mode=development deployment=development transport=https websocket-origins=http://localhost:5173,http://127.0.0.1:5173,http://localhost:11010',
    );
  });
});
