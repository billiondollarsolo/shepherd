/**
 * ConnectivityBanner — a transient error toast shown when the core fleet queries
 * (sessions/nodes) are failing, so a backend/connectivity problem reads as an
 * ERROR rather than a calm "no agents" empty state (which is how it looked before).
 * React Query retries in the background; the banner clears itself on recovery.
 *
 * It renders as an ABSOLUTE overlay toast layered over the top of the session
 * stage rather than an in-flow strip: a zero-height flow wrapper hosts an
 * absolutely-positioned toast, so a network blip appears/disappears WITHOUT
 * reflowing the terminal stage below it (an in-flow strip would resize the
 * center column and trigger an expensive xterm refit on every blip). Entrance
 * rides the shared overlay motion recipe, which the reduced-motion block collapses.
 */
import { AlertTriangle } from 'lucide-react';
import { useNodes, useSessions } from '../../data/queries';

export function ConnectivityBanner(): JSX.Element | null {
  const sessions = useSessions();
  const nodes = useNodes();
  if (!sessions.isError && !nodes.isError) return null;
  return (
    // Zero-height flow wrapper: contributes no layout height (only absolutely
    // positioned content), so the terminal stage below never reflows/refits.
    <div className="relative">
      <div
        role="alert"
        data-testid="connectivity-banner"
        className="animate-overlay-in pointer-events-none absolute inset-x-0 top-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-md border border-status-error/40 bg-status-error/15 px-4 py-1.5 text-xs font-medium text-status-error shadow-flock-md"
      >
        <AlertTriangle className="size-3.5 shrink-0" />
        <span>Can’t reach the orchestrator — Paddock data may be stale. Retrying…</span>
      </div>
    </div>
  );
}
