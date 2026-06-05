/**
 * Audit API client for the admin Audit Log view (US-40, FR-A3).
 *
 * Calls the admin-only `GET /api/audit` and validates the response against the
 * shared `ListAuditResponse` zod contract (never duplicated; @flock/shared). Uses
 * `credentials: 'include'` so the orchestrator's httpOnly session cookie is sent
 * (the route is cookie-authed + admin-only, NFR-SEC6). Mirrors the base-URL +
 * ApiError conventions of `src/routes/api.ts` / `features/center/diffApi.ts` so
 * the web app speaks to the orchestrator the same way everywhere.
 */
import { ListAuditResponse, type ListAuditQuery } from '@flock/shared';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** A failed (non-2xx) audit API call, carrying the server's error code + message. */
export class AuditApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuditApiError';
  }
}

/** The fetch implementation, injectable so the hook/tests need no global fetch. */
export type FetchLike = typeof fetch;

/** Build the `?action=&userId=&limit=&offset=` query string from a filter. */
function buildQuery(query: ListAuditQuery = {}): string {
  const params = new URLSearchParams();
  if (query.action) params.set('action', query.action);
  if (query.userId) params.set('userId', query.userId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Fetch the admin audit log. Resolves to the validated shared
 * {@link ListAuditResponse}; throws {@link AuditApiError} on a non-2xx response
 * (incl. 401 unauthenticated / 403 non-admin) or a contract-violating body.
 */
export async function fetchAuditLog(
  query: ListAuditQuery = {},
  fetchImpl: FetchLike = fetch,
): Promise<ListAuditResponse> {
  const res = await fetchImpl(`${BASE}/api/audit${buildQuery(query)}`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { code?: string; message?: string };
    throw new AuditApiError(
      res.status,
      err.code ?? 'error',
      err.message ?? `Audit request failed (${res.status}).`,
    );
  }

  const parsed = ListAuditResponse.safeParse(body);
  if (!parsed.success) {
    throw new AuditApiError(res.status, 'invalid_response', 'Malformed audit response.');
  }
  return parsed.data;
}

// Re-export the shared types for convenience so consumers import one place.
export type { ListAuditResponse, ListAuditQuery } from '@flock/shared';
