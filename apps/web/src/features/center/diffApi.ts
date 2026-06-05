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

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** A failed (non-2xx) diff API call, carrying the server's error code + message. */
export class DiffApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DiffApiError';
  }
}

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
  return `${BASE}/api/sessions/${sessionId}/diff${q ? `?${q}` : ''}`;
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
  const res = await fetchImpl(diffUrl(sessionId, scope), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { code?: string; message?: string };
    throw new DiffApiError(
      res.status,
      err.code ?? 'error',
      err.message ?? `Diff request failed (${res.status}).`,
    );
  }

  const parsed = DiffResponse.safeParse(body);
  if (!parsed.success) {
    throw new DiffApiError(res.status, 'invalid_response', 'Malformed diff response.');
  }
  return parsed.data;
}

// Re-export the shared response type for convenience so consumers import one place.
export type { DiffResponse } from '@flock/shared';
