import type { FastifyReply, FastifyRequest } from 'fastify';
import { isHookPath, isOrchestratePath } from './surface-guard.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Enforce browser same-origin semantics for every cookie-bearing mutation.
 *
 * SameSite is not a CSRF boundary for Preview's private port-pool mode because
 * ports are different origins but the same site. The Origin header therefore
 * becomes a mandatory, exact authorization input for unsafe control-plane
 * requests. Capability-authenticated hook/orchestration routes remain separate.
 */
export function makeRequestOriginGuard(allowedOrigins: ReadonlySet<string>) {
  return async function requestOriginGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const url = request.url ?? request.raw?.url ?? '';
    if (isHookPath(url) || isOrchestratePath(url)) return;

    const raw = request.headers.origin;
    const origin = Array.isArray(raw) ? null : raw;
    if (!origin || !allowedOrigins.has(origin)) {
      void reply.code(403).send({
        error: {
          code: 'origin_forbidden',
          message: 'This request did not originate from the configured Shepherd UI.',
        },
      });
    }
  };
}
