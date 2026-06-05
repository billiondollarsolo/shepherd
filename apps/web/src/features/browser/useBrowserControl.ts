import { useCallback, useState } from 'react';
import type { BrowserControlResponse, InputIntent } from '@flock/shared';

/**
 * US-28 — Layer C input takeover/release: web control hook.
 *
 * Drives the single-controller takeover/release lifecycle and forwards user
 * input intents while in control. Network + WS are injected as a `transport`
 * seam (mirroring the orchestrator's dependency-injection style) so the hook is
 * unit-testable without a real server/socket and not coupled to a specific
 * fetch helper.
 *
 *  - `takeover()` POSTs /api/sessions/:id/browser/takeover; on success this
 *    client holds control (`inControl` true). A rejected takeover (another
 *    controller holds the lock — single-controller) surfaces as `error` and
 *    leaves `inControl` false.
 *  - `release()` POSTs /api/sessions/:id/browser/release and stops forwarding.
 *  - `sendInput(intent)` forwards a click/scroll/key intent over the
 *    `screencast:<id>` channel ONLY while in control (a no-op otherwise).
 */

/** Injected transport: REST takeover/release + WS input forwarding. */
export interface BrowserControlTransport {
  /** POST /api/sessions/:id/browser/takeover. */
  takeover(sessionId: string): Promise<BrowserControlResponse>;
  /** POST /api/sessions/:id/browser/release. */
  release(sessionId: string): Promise<BrowserControlResponse>;
  /** Forward one input intent over the screencast channel (while in control). */
  sendInput(sessionId: string, intent: InputIntent): void;
}

export interface UseBrowserControl {
  /** Whether THIS client currently holds the single input-control lock. */
  inControl: boolean;
  /** A request is in flight (takeover/release). */
  pending: boolean;
  /** Last error message (e.g. takeover rejected — another controller holds it). */
  error: string | null;
  takeover(): Promise<void>;
  release(): Promise<void>;
  /** Forward a user input intent; no-op unless in control. */
  sendInput(intent: InputIntent): void;
}

export function useBrowserControl(
  sessionId: string,
  transport: BrowserControlTransport,
): UseBrowserControl {
  const [inControl, setInControl] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const takeover = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const res = await transport.takeover(sessionId);
      setInControl(res.inControl);
    } catch (err) {
      setInControl(false);
      setError(err instanceof Error ? err.message : 'takeover failed');
    } finally {
      setPending(false);
    }
  }, [sessionId, transport]);

  const release = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await transport.release(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'release failed');
    } finally {
      // Even if the server response errors, locally we stop forwarding: the
      // user explicitly asked to release control.
      setInControl(false);
      setPending(false);
    }
  }, [sessionId, transport]);

  const sendInput = useCallback(
    (intent: InputIntent) => {
      if (!inControl) return; // release stops forwarding (US-28)
      transport.sendInput(sessionId, intent);
    },
    [inControl, sessionId, transport],
  );

  return { inControl, pending, error, takeover, release, sendInput };
}
