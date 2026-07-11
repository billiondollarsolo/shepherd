/**
 * Audit API client for the owner Audit Log view (US-40, FR-A3).
 *
 * Calls the owner-only `GET /api/audit` and validates the response against the
 * shared `ListAuditResponse` zod contract (never duplicated; @flock/shared). Uses
 * `credentials: 'include'` so the orchestrator's httpOnly session cookie is sent
 * (the route is cookie-authenticated and owner-only). Mirrors the base-URL +
 * ApiError conventions of `src/routes/api.ts` / `features/center/diffApi.ts` so
 * the web app speaks to the orchestrator the same way everywhere.
 */
import { ListAuditResponse, type ListAuditQuery } from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';

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
 * Fetch the owner audit log. Resolves to the validated shared
 * {@link ListAuditResponse}; throws {@link AuditApiError} on a non-2xx response
 * (including 401/403) or a contract-violating body.
 */
export async function fetchAuditLog(
  query: ListAuditQuery = {},
  fetchImpl: FetchLike = fetch,
): Promise<ListAuditResponse> {
  return apiRequest(`/api/audit${buildQuery(query)}`, {
    method: 'GET',
    schema: ListAuditResponse,
    fetchImpl,
    idempotent: true,
    retry: { attempts: 1 },
  });
}

// Re-export the shared types for convenience so consumers import one place.
export type { ListAuditResponse, ListAuditQuery } from '@flock/shared';
