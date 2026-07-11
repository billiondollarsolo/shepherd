import { AuditLogger } from '../../audit/index.js';
import {
  NotInControlError,
  TakeoverConflictError,
  type CdpInputClient,
  type CdpInputClientResolver,
  type InputIntent,
} from './input-types.js';

/** Who is taking control, for the lock + the `browser_takeover` audit row. */
export interface TakeoverActor {
  /** Stable id of the controlling client (the acting user id). */
  controllerId: string;
  /** Source IP for the audit row (FR-A3). */
  ip?: string | null;
}

/** Result of a takeover — mirrors the `inControl` flag of `BrowserControlResponse`. */
export interface TakeoverResult {
  sessionId: string;
  /** True iff the requester now holds the single control lock. */
  inControl: true;
}

export interface InputTakeoverControllerDeps {
  /** Resolves a connected CDP `Input` client for a session's running browser. */
  resolveInputClient: CdpInputClientResolver;
  /** Writes the `browser_takeover` audit row (FR-A3). */
  audit: AuditLogger;
}

/** One held control lock (the live registry entry). */
interface Controlled {
  /** The single controller's id. */
  controllerId: string;
  /** The connected CDP `Input` client, resolved once at takeover. */
  client: CdpInputClient;
}

/**
 * US-28 — Layer C input takeover/release (FR-B4, FR-A3).
 *
 * The HUMAN view/control layer over the SAME isolated Chrome the agent drives
 * (Layer A/B). `takeover` grants a single control lock and forwards user
 * click/scroll/key intents as CDP `Input.*` events; `release` drops the lock and
 * stops forwarding. A second takeover while a controller holds the lock is
 * REJECTED (single-controller, spec §10 edge case "two takeover requests on one
 * browser → second is rejected or queued"). A `browser_takeover` audit row is
 * written on every (new) takeover.
 *
 * Single-controller is the safety invariant: only the lock holder's input is
 * ever forwarded to chrome, so the agent and a second human can't fight over the
 * same page. Forwarding by a non-holder (or after release) throws and reaches no
 * CDP call.
 *
 * Entirely local to the orchestrator VPS — nodes are never touched (PRD §6.4
 * dumb-node invariant). Builds on Layer A's per-session CDP endpoint (US-25) and
 * is the same Chrome that Layer B drives (US-26) and Layer C streams (US-27).
 */
export class InputTakeoverController {
  private readonly resolveInputClient: CdpInputClientResolver;
  private readonly audit: AuditLogger;
  /** sessionId -> held control lock. The live registry of in-control sessions. */
  private readonly controlled = new Map<string, Controlled>();

  constructor(deps: InputTakeoverControllerDeps) {
    this.resolveInputClient = deps.resolveInputClient;
    this.audit = deps.audit;
  }

  /** True iff some client currently holds control of this session's browser. */
  isControlled(sessionId: string): boolean {
    return this.controlled.has(sessionId);
  }

  /** The id of the controlling client, if any. */
  controllerOf(sessionId: string): string | undefined {
    return this.controlled.get(sessionId)?.controllerId;
  }

  /**
   * Take input control of a session's browser.
   *
   * Single-controller: if a DIFFERENT client already holds the lock, this throws
   * {@link TakeoverConflictError} (the second request is rejected). A re-takeover
   * by the SAME controller is idempotent (returns in-control, no extra audit
   * row). On a new grant, resolves the CDP `Input` client once and writes a
   * `browser_takeover` audit row (FR-A3); the audit write is off the critical
   * path, so an audit failure does not break the takeover.
   */
  async takeover(sessionId: string, actor: TakeoverActor): Promise<TakeoverResult> {
    if (!sessionId) throw new Error('sessionId is required');
    if (!actor.controllerId) throw new Error('controllerId is required');

    const held = this.controlled.get(sessionId);
    if (held) {
      if (held.controllerId === actor.controllerId) {
        // Idempotent re-takeover by the same controller.
        return { sessionId, inControl: true };
      }
      throw new TakeoverConflictError(sessionId, held.controllerId);
    }

    const client = await this.resolveInputClient(sessionId);
    this.controlled.set(sessionId, { controllerId: actor.controllerId, client });

    // Audit is off the live path — never let a logging failure break takeover.
    try {
      await this.audit.record({
        action: 'browser_takeover',
        targetType: 'session',
        targetId: sessionId,
        userId: actor.controllerId,
        ip: actor.ip ?? null,
      });
    } catch {
      /* swallow — takeover succeeds regardless (FR-A3 is best-effort here) */
    }

    return { sessionId, inControl: true };
  }

  /**
   * Forward one user-input intent to chrome as a CDP `Input.*` event.
   *
   * Only the current controller may forward; a non-holder (or input after
   * release / before any takeover) throws {@link NotInControlError} and reaches
   * no CDP call. Mouse intents map to `Input.dispatchMouseEvent` (click + scroll
   * via `mouseWheel`); key intents map to `Input.dispatchKeyEvent`.
   */
  async forward(sessionId: string, controllerId: string, intent: InputIntent): Promise<void> {
    const held = this.controlled.get(sessionId);
    if (!held || held.controllerId !== controllerId) {
      throw new NotInControlError(sessionId, controllerId);
    }

    if (intent.kind === 'mouse') {
      await held.client.Input.dispatchMouseEvent(intent.event);
    } else {
      await held.client.Input.dispatchKeyEvent(intent.event);
    }
  }

  /**
   * Release input control. Stops forwarding (the lock is dropped). Only the
   * current controller can release; a release by a non-holder (or of an
   * uncontrolled session) is a harmless no-op that returns `false` and leaves
   * any existing lock intact. Returns `true` when a lock was actually released.
   */
  async release(sessionId: string, controllerId: string): Promise<boolean> {
    const held = this.controlled.get(sessionId);
    if (!held || held.controllerId !== controllerId) return false;
    this.controlled.delete(sessionId);
    return true;
  }

  /** Drop every control lock (orchestrator shutdown / session terminate sweep). */
  async releaseAll(): Promise<void> {
    this.controlled.clear();
  }
}
