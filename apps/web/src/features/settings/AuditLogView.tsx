/**
 * AuditLogView — the owner Audit Log surface (US-40, FR-A3).
 *
 * A simple, calm table of the append-only audit rows
 * (timestamp, action, user, target, ip, detail) fetched from the owner-only
 * `GET /api/audit`, with a filter dropdown to narrow by action and a refresh
 * button. The endpoint is owner-only on the server; authorization remains a
 * server decision and rejected requests show a clear access message.
 *
 * Codex-calm density (Appendix A.4): quiet surfaces, a single accent, status by
 * small text — not loud badges. The audit-action set comes from the shared
 * `@flock/shared` enum so the filter options never drift from the contract.
 */
import { RefreshCw, ScrollText, ShieldAlert } from 'lucide-react';
import { AuditActionEnum, type AuditAction, type AuditEntry } from '@flock/shared';

import {
  Button,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '../../components/ui';
import { useAuditLog } from './useAuditLog';
import type { FetchLike } from './auditApi';

export interface AuditLogViewProps {
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: FetchLike;
}

const ACTION_OPTIONS = AuditActionEnum.options as readonly AuditAction[];

/** Radix Select forbids an empty-string item value, so "all actions" gets a sentinel. */
const ALL_ACTIONS = '__all__';

function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function AuditLogView({ fetchImpl }: AuditLogViewProps = {}): JSX.Element {
  const { entries, loading, error, forbidden, action, setAction, refresh } = useAuditLog({
    fetchImpl,
  });

  return (
    <section className="flex h-full flex-col" aria-label="Audit log" data-testid="audit-log-view">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--flock-border)] px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-flock-ink-primary">Audit log</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-flock-ink-muted">
            <span>Action</span>
            <Select
              value={action ?? ALL_ACTIONS}
              onValueChange={(value) =>
                setAction(value === ALL_ACTIONS ? undefined : (value as AuditAction))
              }
            >
              <SelectTrigger
                aria-label="Filter by action"
                data-testid="audit-action-filter"
                className="h-7 w-40"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ACTIONS}>All actions</SelectItem>
                {ACTION_OPTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            data-testid="audit-refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh
          </Button>
        </div>
      </header>

      {forbidden ? (
        <EmptyState
          data-testid="audit-forbidden"
          className="flex-1"
          icon={<ShieldAlert aria-hidden />}
          title="Owner access required"
          description={error ?? 'Owner access is required to view the audit log.'}
        />
      ) : loading ? (
        <div
          data-testid="audit-loading"
          aria-label="Loading audit log"
          aria-busy="true"
          className="flex-1 space-y-2 px-4 py-4"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : error ? (
        <div
          role="alert"
          className="px-4 py-6 text-sm text-status-error"
          data-testid="audit-error"
        >
          {error}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          data-testid="audit-empty"
          className="flex-1"
          icon={<ScrollText aria-hidden />}
          title="No audit entries"
          description="Owner-visible actions will appear here as they happen."
        />
      ) : (
        <div className="flex-1 overflow-auto px-2 py-2">
          <table className="w-full border-collapse text-left text-sm" data-testid="audit-table">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-flock-ink-muted">
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
                  className="border-t border-[var(--flock-border)] align-top"
                >
                  <td className="whitespace-nowrap px-2 py-1 tabular-nums text-flock-ink-muted">
                    <time dateTime={e.ts}>{formatTs(e.ts)}</time>
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-ink-primary">{e.action}</td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-ink-muted">
                    {e.userId ?? '—'}
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-ink-muted">
                    {e.targetType ? `${e.targetType}:${e.targetId ?? '—'}` : '—'}
                  </td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-ink-muted">{e.ip ?? '—'}</td>
                  <td className="px-2 py-1 font-mono text-xs text-flock-ink-muted">
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
