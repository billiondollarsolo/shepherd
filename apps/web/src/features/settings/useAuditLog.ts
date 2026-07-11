import { useCallback, useEffect, useState } from 'react';
import type { AuditAction, AuditEntry, ListAuditQuery } from '@flock/shared';

import { fetchAuditLog, type FetchLike } from './auditApi';
import { ApiError } from '../../lib/apiClient';

/**
 * US-40 — owner Audit Log view state (FR-A3).
 *
 * Loads `GET /api/audit` (owner-only), exposes the entries + a loading/error
 * state, and lets the view narrow by `action` and refresh. The endpoint is
 * owner-only on the server (401/403); this hook surfaces that as a `forbidden`
 * flag so the view can show a clear access message rather than a raw
 * error — the authorization decision stays on the server (NFR-SEC6).
 *
 * Pure UI state + an injectable `fetchImpl` seam so tests need no global fetch.
 */
export interface UseAuditLogOptions {
  /** Initial action filter (undefined = all actions). */
  initialAction?: AuditAction;
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Page size to request (defaults to the server default). */
  limit?: number;
}

export interface UseAuditLog {
  entries: AuditEntry[];
  loading: boolean;
  /** A human-facing error message, or null. */
  error: string | null;
  /** True when the server rejected the read as forbidden (403) / unauthenticated (401). */
  forbidden: boolean;
  /** The current action filter (undefined = all). */
  action: AuditAction | undefined;
  /** Set the action filter and reload. */
  setAction: (action: AuditAction | undefined) => void;
  /** Re-fetch with the current filter. */
  refresh: () => void;
}

export function useAuditLog(options: UseAuditLogOptions = {}): UseAuditLog {
  const { initialAction, fetchImpl, limit } = options;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [action, setActionState] = useState<AuditAction | undefined>(initialAction);

  const load = useCallback(
    async (filterAction: AuditAction | undefined): Promise<void> => {
      setLoading(true);
      setError(null);
      setForbidden(false);
      try {
        const query: ListAuditQuery = {};
        if (filterAction) query.action = filterAction;
        if (limit !== undefined) query.limit = limit;
        const res = await fetchAuditLog(query, fetchImpl ?? fetch);
        setEntries(res.entries);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          setForbidden(true);
          setError('Owner access is required to view the audit log.');
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError('Could not reach the server.');
        }
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [fetchImpl, limit],
  );

  useEffect(() => {
    void load(action);
  }, [load, action]);

  const setAction = useCallback((next: AuditAction | undefined) => {
    setActionState(next);
  }, []);

  const refresh = useCallback(() => {
    void load(action);
  }, [load, action]);

  return { entries, loading, error, forbidden, action, setAction, refresh };
}
