/**
 * AuditLogView — the admin Audit Log surface (US-40, FR-A3).
 *
 * "Admin can read them": a simple, calm table of the append-only audit rows
 * (timestamp, action, user, target, ip, detail) fetched from the admin-only
 * `GET /api/audit`, with a filter dropdown to narrow by action and a refresh
 * button. The endpoint is admin-only on the SERVER (the authorization decision
 * stays there, NFR-SEC6); when a non-admin reaches this view the server replies
 * 403 and we show a clear "admins only" message instead of a table.
 *
 * Codex-calm density (Appendix A.4): quiet surfaces, a single accent, status by
 * small text — not loud badges. The audit-action set comes from the shared
 * `@flock/shared` enum so the filter options never drift from the contract.
 */
import { AuditActionEnum, type AuditAction, type AuditEntry } from '@flock/shared';

import { useAuditLog } from './useAuditLog';
import type { FetchLike } from './auditApi';

export interface AuditLogViewProps {
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: FetchLike;
}

const ACTION_OPTIONS = AuditActionEnum.options as readonly AuditAction[];

function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function AuditLogView({ fetchImpl }: AuditLogViewProps): JSX.Element {
  const { entries, loading, error, forbidden, action, setAction, refresh } = useAuditLog({
    fetchImpl,
  });

  return (
    <section className="flex h-full flex-col" aria-label="Audit log" data-testid="audit-log-view">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-flock-muted/15 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Audit log</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-flock-muted">
            <span>Action</span>
            <select
              aria-label="Filter by action"
              data-testid="audit-action-filter"
              value={action ?? ''}
              onChange={(e) =>
                setAction(e.target.value === '' ? undefined : (e.target.value as AuditAction))
              }
              className="rounded border border-flock-muted bg-transparent px-1 py-0.5 text-xs"
            >
              <option value="">All actions</option>
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refresh}
            data-testid="audit-refresh"
            className="rounded border border-flock-muted px-2 py-0.5 text-xs"
          >
            Refresh
          </button>
        </div>
      </header>

      {forbidden ? (
        <div
          data-testid="audit-forbidden"
          className="flex flex-1 items-center justify-center px-4 py-6 text-center text-sm text-flock-muted"
        >
          {error ?? 'You need an admin account to view the audit log.'}
        </div>
      ) : loading ? (
        <div
          data-testid="audit-loading"
          className="flex flex-1 items-center justify-center px-4 py-6 text-sm text-flock-muted"
        >
          Loading audit log…
        </div>
      ) : error ? (
        <div role="alert" className="px-4 py-6 text-sm text-red-500" data-testid="audit-error">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div
          data-testid="audit-empty"
          className="flex flex-1 items-center justify-center px-4 py-6 text-sm text-flock-muted"
        >
          No audit entries.
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-2 py-2">
          <table className="w-full border-collapse text-left text-sm" data-testid="audit-table">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-flock-muted">
                <th className="px-2 py-1 font-medium">Time</th>
                <th className="px-2 py-1 font-medium">Action</th>
                <th className="px-2 py-1 font-medium">User</th>
                <th className="px-2 py-1 font-medium">Target</th>
                <th className="px-2 py-1 font-medium">IP</th>
                <th className="px-2 py-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: AuditEntry) => (
                <tr
                  key={e.id}
                  data-testid="audit-row"
                  data-action={e.action}
                  className="border-t border-flock-muted/10 align-top"
                >
                  <td className="whitespace-nowrap px-2 py-1 tabular-nums text-flock-muted">
                    <time dateTime={e.ts}>{formatTs(e.ts)}</time>
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-fg">{e.action}</td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-muted">
                    {e.userId ?? '—'}
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-muted">
                    {e.targetType ? `${e.targetType}:${e.targetId ?? '—'}` : '—'}
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-muted">{e.ip ?? '—'}</td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-muted">
                    {e.detail ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default AuditLogView;
