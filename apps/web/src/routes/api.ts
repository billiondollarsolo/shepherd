/**
 * Tiny auth API client for the Setup/Login screens (US-4/US-5/US-6).
 *
 * All requests use `credentials: 'include'` so the orchestrator's httpOnly
 * session cookie is sent/stored. Request/response shapes come from the shared
 * zod contracts in `@flock/shared` (never duplicated). The base URL is the
 * orchestrator origin (VITE_API_URL); empty by default so a same-origin deploy
 * (TLS-terminated in front, NFR-SEC1) works without configuration.
 */
import type {
  CreateUserRequest,
  LoginRequest,
  SetupRequest,
  User,
} from '@flock/shared';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** A failed (non-2xx) API call, carrying the server's error code + message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  // Only set a JSON content-type when there's a body; an empty body WITH
  // `content-type: application/json` makes Fastify 400 (FST_ERR_CTP_EMPTY_JSON_BODY).
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body != null && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(
      res.status,
      err.code ?? 'error',
      err.message ?? `Request failed (${res.status}).`,
    );
  }
  return body as T;
}

/** POST /api/auth/setup — create the first admin (US-4). */
export function setupAdmin(input: SetupRequest): Promise<{ user: User }> {
  return request('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /api/auth/login — establish a session cookie (US-5). */
export function login(input: LoginRequest): Promise<{ user: User }> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

/** GET /api/auth/me — current user, or throws ApiError(401) when unauthed. */
export function me(): Promise<{ user: User }> {
  return request('/api/auth/me', { method: 'GET' });
}

/** GET /api/auth/status — public first-run probe (no auth required). */
export function authStatus(): Promise<{ setupRequired: boolean }> {
  return request('/api/auth/status', { method: 'GET' });
}

/** POST /api/auth/logout — revoke the session + clear the cookie (US-5). */
export function logout(): Promise<void> {
  return request('/api/auth/logout', { method: 'POST' });
}

/** POST /api/auth/change-password — change own password (verifies the current one). */
export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  return request('/api/auth/change-password', { method: 'POST', body: JSON.stringify(input) });
}

/** POST /api/users — admin invites a member (US-6). */
export function inviteUser(input: CreateUserRequest): Promise<{ user: User }> {
  return request('/api/users', { method: 'POST', body: JSON.stringify(input) });
}
