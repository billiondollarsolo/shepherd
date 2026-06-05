/**
 * ResponsivePaddock — the US-36 (FR-UI6) responsive entry point.
 *
 * Picks the surface from the viewport (`useIsPhone`):
 *   - desktop / tablet → the dense US-30 three-region paddock (unchanged);
 *   - phone            → the collapsed "which agent needs me + approve/deny"
 *                        away view, fed by the same live status map the desktop
 *                        tree uses (`useStatusWebSocket`).
 *
 * Mounting both behind one component keeps the swap in a single, tested place;
 * App just renders <ResponsivePaddock />. The phone view is deliberately driven
 * by the SAME shared attention ordering as the tree (via PhoneView), so the two
 * surfaces can never disagree about "who needs me."
 */
import { useMemo } from 'react';
import type { Status } from '@flock/shared';
import { Paddock } from '../../app';
import { useStatusWebSocket } from '../tree/useStatusWebSocket';
import { PhoneView, type PhoneSession } from './PhoneView';
import { useIsPhone } from './useIsPhone';

export function ResponsivePaddock(): JSX.Element {
  const isPhone = useIsPhone();

  // Mount only ONE surface so the desktop paddock never opens the phone view's
  // status WebSocket (and vice-versa). The status-WS subscription lives inside
  // PhonePaddock so it is created only when the phone view is actually shown.
  if (!isPhone) {
    return <Paddock />;
  }
  return <PhonePaddock />;
}

/**
 * The phone surface: subscribes to the live status map and renders the away
 * view. Kept separate so the WS hook is only mounted on phones. The away view is
 * read-only ("which agent needs me"); remote approve/deny needs a per-agent
 * PTY-respond endpoint that doesn't exist yet, so it is not offered here (rather
 * than POSTing to a 404).
 */
function PhonePaddock(): JSX.Element {
  const { statuses } = useStatusWebSocket();
  const sessions = useMemo<PhoneSession[]>(() => statusesToSessions(statuses), [statuses]);
  return <PhoneView sessions={sessions} />;
}

/**
 * Adapt the live `Map<sessionId, Status>` into the phone view's session list.
 *
 * The rich Node→Project→Session model (with human labels) is owned by the tree
 * stories; until that model is threaded here we derive a readable label from the
 * id so the away view is usable from the live status path alone.
 */
function statusesToSessions(statuses: ReadonlyMap<string, Status>): PhoneSession[] {
  return [...statuses.entries()].map(([id, status]) => ({
    id,
    label: id,
    status,
  }));
}

export default ResponsivePaddock;
