import type { FastifyReply } from 'fastify';
import type { FlockErrorEnvelope } from '@flock/shared';

/** Build the shared error envelope `{ error: { code, message, details? } }` (F2). */
export function errorEnvelope(
  code: string,
  message: string,
  details?: unknown,
): FlockErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Send Shepherd's structured error envelope at the given HTTP status. The single
 * source for route error replies (was hand-rolled per route); the global handler
 * in `buildServer` returns the same shape for uncaught errors (roadmap F2).
 */
export function replyError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  void reply.code(status).send(errorEnvelope(code, message, details));
}

/** 400 Bad Request with code `bad_request` — the common validation reply. */
export function badRequest(reply: FastifyReply, message: string): void {
  replyError(reply, 400, 'bad_request', message);
}
