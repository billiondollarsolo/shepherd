/**
 * Diff API client for the center pane's read-only Diff tab (US-33, FR-UI4).
 *
 * Calls `GET /api/sessions/:id/diff` and validates the response against the
 * shared `DiffResponse` zod contract (never duplicated; @flock/shared). Uses
 * `credentials: 'include'` so the orchestrator's httpOnly session cookie is sent
 * (the route is cookie-authed, NFR-SEC6). Mirrors `src/routes/api.ts`'s
 * base-URL + ApiError conventions so the web app speaks to the orchestrator the
 * same way everywhere.
 */
import { DiffResponse } from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';

/** The fetch implementation, injectable so the hook/tests need no global fetch. */
export type FetchLike = typeof fetch;

/**
 * Which side / file to diff. Omitted → the combined working-tree-vs-HEAD diff
 * (the original read-only Diff tab behaviour). `staged` selects the staged
 * (`--cached`) vs unstaged side; `path` scopes to one file (the Source Control
 * panel's per-file preview).
 */
export interface DiffScope {
  staged?: boolean;
  path?: string;
}

function diffUrl(sessionId: string, scope?: DiffScope): string {
  const params = new URLSearchParams();
  if (scope?.staged !== undefined) params.set('staged', String(scope.staged));
  if (scope?.path) params.set('path', scope.path);
  const q = params.toString();
  return `/api/sessions/${sessionId}/diff${q ? `?${q}` : ''}`;
}

/**
 * Fetch the `git diff` for a session. Resolves to the validated shared
 * {@link DiffResponse}; throws {@link DiffApiError} on a non-2xx response or when
 * the body does not match the contract. `scope` is optional and backward
 * compatible — omitting it returns the combined diff exactly as before.
 */
export async function fetchSessionDiff(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
  scope?: DiffScope,
): Promise<DiffResponse> {
  return apiRequest(diffUrl(sessionId, scope), {
    method: 'GET',
    schema: DiffResponse,
    fetchImpl,
    signal: undefined,
  });
}

// Re-export the shared response type for convenience so consumers import one place.
export type { DiffResponse } from '@flock/shared';
