import type { FastifyReply } from 'fastify';

/**
 * Send Flock's structured error envelope `{ error: { code, message } }` at the
 * given HTTP status. The single source for route error replies (was hand-rolled
 * per route).
 */
export function replyError(reply: FastifyReply, status: number, code: string, message: string): void {
  void reply.code(status).send({ error: { code, message } });
}

/** 400 Bad Request with code `bad_request` — the common validation reply. */
export function badRequest(reply: FastifyReply, message: string): void {
  replyError(reply, 400, 'bad_request', message);
}
