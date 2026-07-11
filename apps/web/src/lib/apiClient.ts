import { ErrorResponse, type ErrorResponse as ErrorEnvelope } from '@flock/shared';
import { z, type ZodType } from 'zod';

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 15_000;

export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'unavailable'
  | 'offline'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'server';

/** One consistent error shape for every browser → orchestrator request. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly kind: ApiErrorKind = classifyApiError(status),
    options?: { cause?: unknown },
    readonly details?: unknown,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

export function classifyApiError(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'server';
}

export interface ApiRetryOptions {
  /** Number of retries after the initial attempt. */
  attempts: number;
  baseDelayMs?: number;
}

interface ApiRequestBase extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Must be explicitly true before network/5xx retries are allowed. */
  idempotent?: boolean;
  retry?: ApiRetryOptions;
  idempotencyKey?: string;
}

interface JsonApiRequest<S extends ZodType> extends ApiRequestBase {
  schema: S;
  response?: 'json';
}

interface VoidApiRequest extends ApiRequestBase {
  response: 'void';
  schema?: never;
}

function retryable(error: unknown): boolean {
  return (
    (error instanceof ApiError && (error.kind === 'offline' || error.kind === 'unavailable')) ||
    (error instanceof TypeError && error.name !== 'AbortError')
  );
}

function abortContext(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = globalThis.setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException('Request timed out.', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    if (response.ok) {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The server returned malformed JSON.',
        'invalid_response',
        { cause },
      );
    }
    return undefined;
  }
}

function errorEnvelope(body: unknown): ErrorEnvelope | null {
  const parsed = ErrorResponse.safeParse(body);
  return parsed.success ? parsed.data : null;
}

async function once<S extends ZodType>(
  path: string,
  options: JsonApiRequest<S> | VoidApiRequest,
): Promise<z.infer<S> | void> {
  const {
    schema,
    response: responseMode,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    idempotent: _idempotent,
    retry: _retry,
    idempotencyKey,
    signal: externalSignal,
    ...init
  } = options;
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  const abort = abortContext(externalSignal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        ...init,
        credentials: 'include',
        headers,
        signal: abort.signal,
      });
    } catch (cause) {
      if (abort.signal.aborted) {
        const kind = abort.timedOut() ? 'timeout' : 'aborted';
        throw new ApiError(
          0,
          kind,
          kind === 'timeout' ? 'Request timed out.' : 'Request aborted.',
          kind,
          {
            cause,
          },
        );
      }
      throw new ApiError(0, 'offline', 'Cannot reach the orchestrator.', 'offline', { cause });
    }

    const body = response.status === 204 ? undefined : await responseBody(response);
    if (!response.ok) {
      const envelope = errorEnvelope(body);
      throw new ApiError(
        response.status,
        envelope?.error.code ?? 'error',
        envelope?.error.message ?? `Request failed (${response.status}).`,
        classifyApiError(response.status),
        undefined,
        envelope?.error.details,
      );
    }
    if (responseMode === 'void') {
      if (response.status !== 204 && body !== undefined) {
        throw new ApiError(
          response.status,
          'invalid_response',
          'The server returned an unexpected response body.',
          'invalid_response',
        );
      }
      return;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The server response did not match the expected contract.',
        'invalid_response',
        { cause: parsed.error },
      );
    }
    return parsed.data;
  } finally {
    abort.dispose();
  }
}

export async function apiRequest<S extends ZodType>(
  path: string,
  options: JsonApiRequest<S>,
): Promise<z.infer<S>>;
export async function apiRequest(path: string, options: VoidApiRequest): Promise<void>;
export async function apiRequest<S extends ZodType>(
  path: string,
  options: JsonApiRequest<S> | VoidApiRequest,
): Promise<z.infer<S> | void> {
  const retries = options.idempotent ? Math.max(0, options.retry?.attempts ?? 0) : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once(path, options);
    } catch (error) {
      if (attempt >= retries || !retryable(error) || options.signal?.aborted) throw error;
      const base = Math.max(1, options.retry?.baseDelayMs ?? 150);
      const cap = base * 2 ** attempt;
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.random() * cap));
    }
  }
}
