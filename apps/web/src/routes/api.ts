/**
 * Auth endpoint module for the owner Setup/Login screens (US-4/US-5).
 *
 * All requests use `credentials: 'include'` so the orchestrator's httpOnly
 * session cookie is sent/stored. Request/response shapes come from the shared
 * zod contracts in `@flock/shared` (never duplicated). The base URL is the
 * orchestrator origin (VITE_API_URL); empty by default so a same-origin deploy
 * (TLS-terminated in front, NFR-SEC1) works without configuration.
 */
import {
  AuthStatusResponse,
  LoginResponse,
  MeResponse,
  SetupResponse,
  UpdateProfileResponse,
  type LoginRequest,
  type SetupRequest,
} from '@flock/shared';
import { apiRequest } from '../lib/apiClient';
export { ApiError } from '../lib/apiClient';

/** POST /api/auth/setup — create the installation owner (US-4). */
export function setupOwner(input: SetupRequest): Promise<SetupResponse> {
  return apiRequest('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(input),
    schema: SetupResponse,
  });
}

/** POST /api/auth/login — establish a session cookie (US-5). */
export function login(input: LoginRequest): Promise<LoginResponse> {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
    schema: LoginResponse,
  });
}

/** GET /api/auth/me — current user, or throws ApiError(401) when unauthed. */
export function me(options: { signal?: AbortSignal } = {}): Promise<MeResponse> {
  return apiRequest('/api/auth/me', { method: 'GET', schema: MeResponse, ...options });
}

/** GET /api/auth/status — public first-run probe (no auth required). */
export function authStatus(options: { signal?: AbortSignal } = {}): Promise<AuthStatusResponse> {
  return apiRequest('/api/auth/status', { method: 'GET', schema: AuthStatusResponse, ...options });
}

/** POST /api/auth/logout — revoke the session + clear the cookie (US-5). */
export function logout(): Promise<void> {
  return apiRequest('/api/auth/logout', { method: 'POST', response: 'void' });
}

/** PATCH /api/auth/me — update own profile (display name). Returns the new user. */
export function updateProfile(input: {
  displayName: string | null;
}): Promise<UpdateProfileResponse> {
  return apiRequest('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(input),
    schema: UpdateProfileResponse,
  });
}

/** POST /api/auth/change-password — change own password (verifies the current one). */
export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  return apiRequest('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
    response: 'void',
  });
}
