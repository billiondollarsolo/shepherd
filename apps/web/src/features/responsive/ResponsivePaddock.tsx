/**
 * ResponsivePaddock — desktop paddock shell vs phone Agents stage.
 *
 * Phone uses the same openAgent selection store and injects into real pty WS
 * via sendPhoneInject (not a no-op Stage/Send).
 */
import { useMemo } from 'react';
import type { Status } from '@flock/shared';
import { Paddock } from '../../app';
import { useSessions } from '../../data/queries';
import { useStatusWebSocket } from '../tree/useStatusWebSocket';
import { PhoneView, type PhoneSession } from './PhoneView';
import { useIsPhone } from './useIsPhone';
import { sendPhoneInject } from './phoneInject';

export function ResponsivePaddock(): JSX.Element {
  const isPhone = useIsPhone();

  if (!isPhone) {
    return <Paddock />;
  }
  return <PhonePaddock />;
}

function PhonePaddock(): JSX.Element {
  const { statuses } = useStatusWebSocket();
  const { data: sessions = [] } = useSessions();
  const phoneSessions = useMemo<PhoneSession[]>(
    () => mergePhoneSessions(statuses, sessions),
    [statuses, sessions],
  );
  return (
    <PhoneView
      sessions={phoneSessions}
      onSendInput={async (sessionId, text, submit) => {
        await sendPhoneInject(sessionId, text, submit);
      }}
    />
  );
}

function mergePhoneSessions(
  statuses: ReadonlyMap<string, Status>,
  sessions: ReadonlyArray<{
    id: string;
    agentType: string;
    projectId: string;
    closedAt: string | null;
    status: Status;
  }>,
): PhoneSession[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ids = new Set([...statuses.keys(), ...sessions.filter((s) => !s.closedAt).map((s) => s.id)]);
  return [...ids].map((id) => {
    const rec = byId.get(id);
    const status: Status = statuses.get(id) ?? rec?.status ?? 'idle';
    return {
      id,
      label: rec ? `${rec.agentType} · ${id.slice(0, 6)}` : id,
      status,
      projectId: rec?.projectId,
    };
  });
}

export default ResponsivePaddock;
