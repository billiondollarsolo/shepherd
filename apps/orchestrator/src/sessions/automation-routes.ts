/**
 * Session automation REST façade (H2.2 / D12).
 *
 *   POST /api/sessions/:id/prompt          { text }
 *   POST /api/sessions/:id/wait            { until?, timeoutMs? }
 *   GET  /api/sessions/:id/status-explain
 *   POST /api/sessions/:id/keys            { keys: string[] }
 *
 * Auth (either):
 *   - Browser cookie via `requireAuth` (human operator), or
 *   - Project automation token: `Authorization: Bearer …` / `X-Automation-Token`
 *     (agent skill / FLOCK_ORCHESTRATE_TOKEN) resolved through
 *     {@link AutomationRouteDeps.resolveAutomationScope} or
 *     {@link AutomationRouteDeps.authorizeAutomationToken}.
 *
 * When a token is present, D12 project-sibling scope is enforced before any op.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentCapabilityScope } from '@flock/shared';
import { SessionIdParams } from '@flock/shared';
import { badRequest } from '../http/reply.js';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { makeRequireAuth } from '../auth/middleware.js';
import { readSessionCookie } from '../auth/cookie.js';
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

/** Map automation verb → capability scope (same catalog as orchestration). */
export function scopeForAutomationAction(action: string): AgentCapabilityScope {
  switch (action) {
    case 'list':
      return 'agents:list:project';
    case 'wait':
    case 'read':
      return 'agents:read:project';
    case 'prompt':
    case 'keys':
      return 'agents:send:project';
    case 'create':
      return 'agents:spawn:project';
    default:
      // fail closed: require send for unknown mutating verbs
      return 'agents:send:project';
  }
}

export interface AutomationRouteDeps {
  auth: AuthGuardDeps;
  getSession: (id: string) => Promise<AutomationSessionInfo | null> | AutomationSessionInfo | null;
  /**
   * Resolve an automation token string into a project-scoped AutomationScope.
   * Preferred production path: wrap AgentCapabilityService.authorizeToken.
   */
  resolveAutomationScope?: (
    request: FastifyRequest,
    action: string,
  ) => Promise<AutomationScope | null> | AutomationScope | null;
  /**
   * Alternate pure token→scope for tests / thin wiring:
   * (token, requiredScope) → scope or throw/null.
   */
  authorizeAutomationToken?: (
    token: string,
    required: AgentCapabilityScope,
  ) => Promise<AutomationScope | null> | AutomationScope | null;
  prompt?: (sessionId: string, text: string) => Promise<void>;
  sendKeys?: (sessionId: string, keys: string[]) => Promise<void>;
  waitStatus?: (
    sessionId: string,
    until: string[] | undefined,
    timeoutMs: number,
  ) => Promise<string>;
  statusExplain?: (sessionId: string) => Promise<unknown>;
  /** @deprecated use waitStatus */
  waitImplemented?: boolean;
}

export function automationHeaderToken(request: FastifyRequest): string | null {
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

/**
 * Cookie operator OR automation token. Token path does not require a cookie.
 * Returns the resolved automation scope (null when cookie-only operator).
 * Sends 401 and returns 'denied' when neither path authenticates.
 */
async function authenticateAutomation(
  deps: AutomationRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
): Promise<AutomationScope | null | 'denied'> {
  const token = automationHeaderToken(request);
  if (token) {
    try {
      if (deps.resolveAutomationScope) {
        const scope = await deps.resolveAutomationScope(request, action);
        if (scope) {
          request.authUser = request.authUser ?? {
            id: '00000000-0000-4000-8000-0000000000aa',
            username: 'automation-token',
            createdAt: new Date(0).toISOString(),
            lastLoginAt: null,
            isActive: true,
          };
          return scope;
        }
      }
      if (deps.authorizeAutomationToken) {
        const required = scopeForAutomationAction(action);
        const scope = await deps.authorizeAutomationToken(token, required);
        if (scope) {
          request.authUser = request.authUser ?? {
            id: '00000000-0000-4000-8000-0000000000aa',
            username: 'automation-token',
            createdAt: new Date(0).toISOString(),
            lastLoginAt: null,
            isActive: true,
          };
          return scope;
        }
      }
    } catch {
      void reply.code(401).send({
        error: { code: 'unauthorized', message: 'Invalid or insufficient automation token.' },
      });
      return 'denied';
    }
    void reply.code(401).send({
      error: { code: 'unauthorized', message: 'Invalid or insufficient automation token.' },
    });
    return 'denied';
  }

  // Cookie path (human operator)
  const cookie = readSessionCookie(request.headers.cookie);
  if (!cookie) {
    void reply.code(401).send({
      error: { code: 'unauthorized', message: 'Authentication required.' },
    });
    return 'denied';
  }
  const user = await deps.auth.getUserBySession(cookie);
  if (!user) {
    void reply.code(401).send({
      error: { code: 'unauthorized', message: 'Authentication required.' },
    });
    return 'denied';
  }
  request.authUser = user;
  return null;
}

export function registerAutomationRoutes(app: FastifyInstance, deps: AutomationRouteDeps): void {
  // Cookie-only guard kept for any nested use; primary handlers use authenticateAutomation.
  const _requireAuth = makeRequireAuth(deps.auth);
  void _requireAuth;

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

  async function gate(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AutomationSessionInfo,
    action: string,
  ): Promise<boolean> {
    const auth = await authenticateAutomation(deps, request, reply, action);
    if (auth === 'denied') return false;
    if (auth) {
      try {
        assertProjectAutomation(auth, action, session.projectId);
      } catch (err) {
        mapAutomationError(reply, err);
        return false;
      }
    }
    return true;
  }

  app.post('/api/sessions/:id/prompt', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return;
    if (!(await gate(request, reply, session, 'prompt'))) return;

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
  });

  app.post('/api/sessions/:id/wait', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return;
    if (!(await gate(request, reply, session, 'wait'))) return;

    const body = (request.body ?? {}) as { until?: unknown; timeoutMs?: unknown };
    try {
      if (body.until !== undefined && !Array.isArray(body.until)) {
        throw new AutomationBadRequestError('until must be an array of status strings when set.');
      }
      const timeoutMs = normalizeWaitTimeoutMs(
        typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      );
      const until = Array.isArray(body.until)
        ? body.until.filter((u): u is string => typeof u === 'string')
        : undefined;

      if (deps.waitStatus) {
        try {
          const status = await deps.waitStatus(session.id, until, timeoutMs);
          return reply.code(200).send({ ok: true, status, sessionId: session.id });
        } catch (waitErr) {
          const message = waitErr instanceof Error ? waitErr.message : String(waitErr);
          if (/timeout/i.test(message)) {
            return reply.code(408).send({ error: { code: 'wait_timeout', message } });
          }
          return reply.code(409).send({ error: { code: 'wait_failed', message } });
        }
      }

      if (!deps.waitImplemented) {
        return reply.code(501).send({
          error: {
            code: 'automation_wait_not_implemented',
            message: 'session wait (PTY / status long-poll) is not wired yet.',
          },
        });
      }

      return reply
        .code(200)
        .send({ ok: true, status: session.status ?? 'unknown', sessionId: session.id });
    } catch (err) {
      const mapped = mapAutomationError(reply, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get('/api/sessions/:id/status-explain', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return;
    if (!(await gate(request, reply, session, 'read'))) return;

    if (deps.statusExplain) {
      try {
        const live = await deps.statusExplain(session.id);
        return reply.code(200).send(live);
      } catch {
        // fall through
      }
    }

    return reply.code(200).send(
      buildExplainResponse(
        session.agentType ?? 'unknown',
        session.status ?? 'unknown',
        session.matchedRuleId ?? undefined,
        session.statusSource ?? undefined,
      ),
    );
  });

  app.post('/api/sessions/:id/keys', async (request, reply) => {
    const session = await loadSession(request, reply);
    if (!session) return;
    if (!(await gate(request, reply, session, 'keys'))) return;

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
  });
}

/** @internal test helper */
export function peekAutomationToken(request: FastifyRequest): string | null {
  return automationHeaderToken(request);
}
