/**
 * Mounted in the authed shell: pushes local selection and pulls remote LWW.
 */
import { useEffect, useRef } from 'react';
import { usePaddock } from '../../store/paddock';
import { runFleetSelectionTick } from './fleetSelectionSync';

const POLL_MS = 2500;

export function FleetSelectionSync(): null {
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const hostScope = usePaddock((s) => s.hostScope);
  const lens = usePaddock((s) => s.lens);
  const follow = usePaddock((s) => s.fleetSelectionFollow);
  /** Last identity we intentionally synced (after apply or put). null = cold start. */
  const lastSyncedKey = useRef<string | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (inflight.current || cancelled) return;
      inflight.current = true;
      try {
        const slice = {
          selectedSessionId,
          selectedProjectId,
          hostScope,
          lens,
          fleetSelectionFollow: follow,
        };
        const result = await runFleetSelectionTick({
          slice,
          lastSyncedKey: lastSyncedKey.current,
        });
        if (cancelled) return;
        lastSyncedKey.current = result.writeKey;
        if (result.apply) {
          usePaddock.setState({
            selectedSessionId: result.apply.selectedSessionId,
            selectedProjectId: result.apply.selectedProjectId,
            ...(result.apply.hostScope !== undefined ? { hostScope: result.apply.hostScope } : {}),
            ...(result.apply.lens !== undefined ? { lens: result.apply.lens } : {}),
            ...(result.apply.view !== undefined ? { view: result.apply.view } : {}),
          });
        }
      } catch {
        /* offline / unauthed — ignore */
      } finally {
        inflight.current = false;
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedSessionId, selectedProjectId, hostScope, lens, follow]);

  return null;
}
