/**
 * Pure helpers for the session automation façade (H2.2 / D12).
 *
 * Routes and agentd bridges build request/response shapes here so authz and
 * payload contracts stay unit-testable without Fastify or a live PTY.
 */
import { allowAutomation, type AutomationScope } from './automation-authz.js';

/** Automation token cannot act on this project (or requested admin). */
export class AutomationAuthzError extends Error {
  readonly code = 'automation_denied' as const;
  constructor(
    message = 'Automation token cannot perform this action on the target project.',
  ) {
    super(message);
    this.name = 'AutomationAuthzError';
  }
}

/** Invalid automation request body / args. */
export class AutomationBadRequestError extends Error {
  readonly code = 'bad_request' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AutomationBadRequestError';
  }
}

/**
 * Throw {@link AutomationAuthzError} when the scope may not perform `action`
 * on `projectId`. Call only when an automation token/scope is present.
 */
export function assertProjectAutomation(
  scope: AutomationScope,
  action: string,
  projectId: string,
): void {
  if (!allowAutomation(scope, action, projectId)) {
    throw new AutomationAuthzError(
      `Automation scope for project "${scope.projectId}" cannot ${action} project "${projectId}".`,
    );
  }
}

/** Build the agentd / internal prompt op payload. */
export function buildPromptRequest(text: string): { text: string; op: 'session.prompt' } {
  if (typeof text !== 'string') {
    throw new AutomationBadRequestError('text must be a string.');
  }
  const trimmed = text;
  if (trimmed.length === 0) {
    throw new AutomationBadRequestError('text is required.');
  }
  return { text: trimmed, op: 'session.prompt' };
}

/** Logical keys payload for `session.send_keys`. */
export function buildKeysRequest(keys: string[]): { keys: string[]; op: 'session.send_keys' } {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new AutomationBadRequestError('keys must be a non-empty string array.');
  }
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) {
    throw new AutomationBadRequestError('each key must be a non-empty string.');
  }
  return { keys, op: 'session.send_keys' };
}

export type StatusExplainResponse = {
  agent: string;
  state: string;
  matchedRuleId?: string;
  source?: string;
};

/**
 * Build the public status-explain object (H1.4 shape subset).
 * Extra detection fields can be merged by the route once agentd explain is wired.
 */
export function buildExplainResponse(
  agent: string,
  state: string,
  matchedRuleId?: string,
  source?: string,
): StatusExplainResponse {
  const out: StatusExplainResponse = { agent, state };
  if (matchedRuleId !== undefined && matchedRuleId !== '') {
    out.matchedRuleId = matchedRuleId;
  }
  if (source !== undefined && source !== '') {
    out.source = source;
  }
  return out;
}

/** Cap wait timeouts for automation long-poll (DoS guard). */
export const AUTOMATION_WAIT_MAX_MS = 10 * 60 * 1000;
export const AUTOMATION_WAIT_DEFAULT_MS = 120_000;

export function normalizeWaitTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || timeoutMs === null) return AUTOMATION_WAIT_DEFAULT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new AutomationBadRequestError('timeoutMs must be a non-negative number.');
  }
  return Math.min(Math.floor(timeoutMs), AUTOMATION_WAIT_MAX_MS);
}
