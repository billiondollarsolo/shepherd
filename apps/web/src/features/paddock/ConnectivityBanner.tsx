/**
 * ConnectivityBanner — a persistent error strip shown when the core fleet queries
 * (sessions/nodes) are failing, so a backend/connectivity problem reads as an
 * ERROR rather than a calm "no agents" empty state (which is how it looked before).
 * React Query retries in the background; the banner clears itself on recovery.
 */
import { AlertTriangle } from 'lucide-react';
import { useNodes, useSessions } from '../../data/queries';

export function ConnectivityBanner(): JSX.Element | null {
  const sessions = useSessions();
  const nodes = useNodes();
  if (!sessions.isError && !nodes.isError) return null;
  return (
    <div
      role="alert"
      data-testid="connectivity-banner"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-status-error/40 bg-status-error/15 px-4 py-1.5 text-xs font-medium text-status-error"
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span>Can’t reach the orchestrator — the fleet may be stale. Retrying…</span>
    </div>
  );
}
