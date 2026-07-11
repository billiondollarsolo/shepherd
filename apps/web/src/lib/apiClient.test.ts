import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiRequest } from './apiClient';

const OkSchema = z.object({ value: z.string() });

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiRequest', () => {
  it('validates successful JSON and supplies cookie/accept defaults', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe('include');
      expect(new Headers(init?.headers).get('accept')).toBe('application/json');
      return response({ value: 'ok' });
    });
    await expect(apiRequest('/ok', { schema: OkSchema, fetchImpl })).resolves.toEqual({
      value: 'ok',
    });
  });

  it('adds JSON content-type only when a body exists and supports 204', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      return response(undefined, 204);
    });
    await expect(
      apiRequest('/empty', {
        method: 'DELETE',
        body: JSON.stringify({ id: 1 }),
        response: 'void',
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [500, 'server'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { code: 'fixture', message: 'Fixture failure.' } }, status),
    );
    const promise = apiRequest('/failure', { schema: OkSchema, fetchImpl });
    await expect(promise).rejects.toMatchObject({ status, code: 'fixture', kind });
  });

  it('rejects malformed JSON and wrong success schemas', async () => {
    const malformed = vi.fn(async () => new Response('{', { status: 200 }));
    await expect(
      apiRequest('/bad-json', { schema: OkSchema, fetchImpl: malformed }),
    ).rejects.toMatchObject({ code: 'invalid_response', kind: 'invalid_response' });
    const wrong = vi.fn(async () => response({ value: 123 }));
    await expect(
      apiRequest('/bad-shape', { schema: OkSchema, fetchImpl: wrong }),
    ).rejects.toMatchObject({ code: 'invalid_response', kind: 'invalid_response' });
  });

  it('distinguishes offline, timeout, and caller abort', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await expect(
      apiRequest('/offline', { schema: OkSchema, fetchImpl: offline }),
    ).rejects.toMatchObject({
      kind: 'offline',
    });

    const hanging = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      apiRequest('/timeout', { schema: OkSchema, fetchImpl: hanging, timeoutMs: 5 }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    const controller = new AbortController();
    const aborted = apiRequest('/aborted', {
      schema: OkSchema,
      fetchImpl: hanging,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('retries only explicitly idempotent transient requests', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response({ value: 'recovered' }));
    await expect(
      apiRequest('/retry', {
        schema: OkSchema,
        fetchImpl,
        idempotent: true,
        retry: { attempts: 1, baseDelayMs: 1 },
      }),
    ).resolves.toEqual({ value: 'recovered' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and never retries a write without an idempotency declaration', async () => {
    const bounded = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(
      apiRequest('/bounded', {
        schema: OkSchema,
        fetchImpl: bounded,
        idempotent: true,
        retry: { attempts: 2, baseDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ kind: 'offline' });
    expect(bounded).toHaveBeenCalledTimes(3);

    const unsafe = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(
      apiRequest('/unsafe', {
        method: 'POST',
        schema: OkSchema,
        fetchImpl: unsafe,
        retry: { attempts: 4, baseDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ kind: 'offline' });
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it('preserves ApiError identity for feature-level handling', async () => {
    const fetchImpl = vi.fn(async () => response(undefined, 503));
    await expect(apiRequest('/down', { schema: OkSchema, fetchImpl })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
