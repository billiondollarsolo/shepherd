/**
 * Session automation REST façade (H2.2 / D12).
 *
 *   POST /api/sessions/:id/prompt          { text }
 *   POST /api/sessions/:id/wait            { until?, timeoutMs? }
 *   GET  /api/sessions/:id/status-explain
 *   POST /api/sessions/:id/keys            { keys: string[] }
 *
 * Cookie-authed like other session routes (`requireAuth`). When an automation
 * scope is present (resolved from `X-Automation-Token` or injected resolver),
 * every handler calls {@link assertProjectAutomation} so project-sibling
 * tokens cannot act cross-project or as admin (D12).
 *
 * Wait / prompt / keys may return 501 with a clear code when agentd PTY ops
 * are not wired yet; authz still runs first.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import type { AutomationScope } from './automation-authz.js';
import {
  AutomationAuthzError,
  AutomationBadRequestError,
  assertProjectAutomation,
  buildExplainResponse,
  buildKeysRequest,
  buildPromptRequest,
  normalizeWaitTimeoutMs,
} from './automation-service.js';

/** Minimal session fields automation routes need. */
export interface AutomationSessionInfo {
  id: string;
  projectId: string;
  /** Wire status when known (for wait stub / explain). */
  status?: string | null;
  agentType?: string | null;
  matchedRuleId?: string | null;
  statusSource?: string | null;
}

export interface AutomationRouteDeps {
  auth: AuthGuardDeps;
  getSession: (id: string) => Promise<AutomationSessionInfo | null> | AutomationSessionInfo | null;
  /**
   * Optional: resolve project-scoped automation token into a scope.
   * When null/undefined, only cookie auth applies (operator path).
   */
  resolveAutomationScope?: (
    request: FastifyRequest,
  ) => Promise<AutomationScope | null> | AutomationScope | null;
  /**
   * When provided, prompt is forwarded; otherwise 501 `automation_not_implemented`.
   */
  prompt?: (sessionId: string, text: string) => Promise<void>;
  /**
   * When provided, keys are forwarded; otherwise 501.
   */
  sendKeys?: (sessionId: string, keys: string[]) => Promise<void>;
  /**
   * When true, wait returns `{ ok, status }` for a known session after authz
   * (no long-poll). When false/omitted, wait returns 501 after authz.
   */
  waitImplemented?: boolean;
}

function automationHeaderToken(request: FastifyRequest): string | null {
  const raw = request.headers['x-automation-token'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  const auth = request.headers.authorization ?? '';
  if (auth.startsWith('Bearer ') && auth.length > 'Bearer '.length) {
    return auth.slice('Bearer '.length).trim() || null;
  }
  return null;
}

function mapAutomationError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof AutomationAuthzError) {
    return reply.code(403).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof AutomationBadRequestError) {
    return reply.code(400).send({ error: { code: err.code, message: err.message } });
  }
  return null;
}

async function resolveScope(
  deps: AutomationRouteDeps,
  request: FastifyRequest,
): Promise<AutomationScope | null> {
  if (deps.resolveAutomationScope) {
    return (await deps.resolveAutomationScope(request)) ?? null;
  }
  // Default: presence of automation header without a resolver is not enough to
  // mint a scope (token validation lives with the caller). Cookie path proceeds.
  void automationHeaderToken(request);
  return null;
}

/**
 * Register automation façade routes. Safe to call when only auth + getSession
 * are available; mutating ops return 501 until backends are injected.
 */
export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRouteDeps): void {
  const requireAuth = makeRequireAuth(deps.auth);

  async function loadSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AutomationSessionInfo | null> {
    const params = SessionIdParams.safeParse(request.params);
    if (!params.success) {
      badRequest(reply, 'a valid session id is required.');
      return null;
    }
    const session = await deps.getSession(params.data.id);
    if (!session) {
      void reply
        .code(404)
        .send({ error: { code: 'session_not_found', message: 'session not found' } });
      return null;
    }
    return session;
  }

  async function enforceAutomation(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AutomationSessionInfo,
    action: string,
  ): Promise<boolean> {
    const scope = await resolveScope(deps, request);
    if (!scope) return true;
    try {
      assertProjectAutomation(scope, action, session.projectId);
      return true;
    } catch (err) {
      mapAutomationError(reply, err);
      return false;
    }
  }

  app.post(
    '/api/sessions/:id/prompt',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await loadSession(request, reply);
      if (!session) return;
      if (!(await enforceAutomation(request, reply, session, 'prompt'))) return;

      const body = (request.body ?? {}) as { text?: unknown };
      try {
        const payload = buildPromptRequest(typeof body.text === 'string' ? body.text : '');
        if (!deps.prompt) {
          return reply.code(501).send({
            error: {
              code: 'automation_not_implemented',
              message: 'session.prompt is not wired on this orchestrator yet.',
            },
          });
        }
        await deps.prompt(session.id, payload.text);
        return reply.code(200).send({ ok: true, op: payload.op });
      } catch (err) {
        const mapped = mapAutomationError(reply, err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  app.post(
    '/api/sessions/:id/wait',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await loadSession(request, reply);
      if (!session) return;
      if (!(await enforceAutomation(request, reply, session, 'wait'))) return;

      const body = (request.body ?? {}) as { until?: unknown; timeoutMs?: unknown };
      try {
        // Validate timeout even on the stub path.
        normalizeWaitTimeoutMs(
          typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        );
        if (body.until !== undefined && !Array.isArray(body.until)) {
          throw new AutomationBadRequestError('until must be an array of status strings when set.');
        }

        if (!deps.waitImplemented) {
          return reply.code(501).send({
            error: {
              code: 'automation_wait_not_implemented',
              message: 'session wait (PTY / status long-poll) is not wired yet.',
            },
          });
        }

        const status = session.status ?? 'unknown';
        return reply.code(200).send({ ok: true, status, sessionId: session.id });
      } catch (err) {
        const mapped = mapAutomationError(reply, err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  app.get(
    '/api/sessions/:id/status-explain',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await loadSession(request, reply);
      if (!session) return;
      if (!(await enforceAutomation(request, reply, session, 'read'))) return;

      const explain = buildExplainResponse(
        session.agentType ?? 'unknown',
        session.status ?? 'unknown',
        session.matchedRuleId ?? undefined,
        session.statusSource ?? undefined,
      );
      return reply.code(200).send(explain);
    },
  );

  app.post(
    '/api/sessions/:id/keys',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await loadSession(request, reply);
      if (!session) return;
      if (!(await enforceAutomation(request, reply, session, 'keys'))) return;

      const body = (request.body ?? {}) as { keys?: unknown };
      try {
        const keys = Array.isArray(body.keys)
          ? body.keys.filter((k): k is string => typeof k === 'string')
          : [];
        const payload = buildKeysRequest(keys);
        if (!deps.sendKeys) {
          return reply.code(501).send({
            error: {
              code: 'automation_not_implemented',
              message: 'session.send_keys is not wired on this orchestrator yet.',
            },
          });
        }
        await deps.sendKeys(session.id, payload.keys);
        return reply.code(200).send({ ok: true, op: payload.op });
      } catch (err) {
        const mapped = mapAutomationError(reply, err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );
}

/** @internal test helper — parse automation token header without resolving scope. */
export function peekAutomationToken(request: FastifyRequest): string | null {
  return automationHeaderToken(request);
}
