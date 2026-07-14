/**
 * Shepherd OpenCode plugin (US-18, spec §7.1, §8.1).
 *
 * Shepherd installs this file as `~/.config/opencode/plugin/flock.js`. It is inert
 * outside a Shepherd session because the callback URL/token environment is absent.
 * OpenCode auto-loads every file under its plugin directory.
 *
 * The plugin is a DUMB COURIER (PRD §6.4): it holds no logic of its own. It
 * subscribes to the OpenCode event bus and POSTs each relevant event verbatim to
 * the orchestrator's hook endpoint. All status derivation happens server-side in
 * the OpenCode translator (`status/translators/opencode.ts`). The node never
 * interprets events.
 *
 * Auth + addressing — read from the per-session environment Shepherd injects when
 * it launches the agent (one `session_id` threads the tmux session name, hook
 * token, node, project, and owner — the single authoritative session record):
 *
 *   FLOCK_HOOK_URL    full URL of `POST /api/hooks/:sessionId` reached over the
 *                     loopback-bound reverse tunnel (SSH nodes) or directly
 *                     (local node). Already contains the sessionId path segment.
 *   FLOCK_HOOK_TOKEN  the per-session hook token; sent as a Bearer token in the
 *                     `Authorization` header (NOT a cookie). The endpoint
 *                     compares it against `hook_token_hash` (NFR-SEC3).
 *
 * The POST body is the raw OpenCode event `{ type, sessionID?, properties? }`
 * plus `{ agentType: "opencode" }` so the orchestrator can pick the OpenCode
 * translator without a DB lookup (keeping the hook path DB-free, spec §15).
 *
 * Events forwarded (the ones the translator maps, spec §7.1 OpenCode column):
 *   session.start        -> starting
 *   tool.execute.before  -> running
 *   tool.execute.after   -> running | error
 *   permission.request   -> awaiting_input   (the money state)
 *   question.ask         -> awaiting_input   (the money state)
 *   session.idle         -> idle
 *   session.error        -> error
 *   session.complete     -> done
 *   message.updated      -> (telemetry only) model + tokens + cost
 *   session.updated      -> (telemetry only) model + tokens + cost
 *
 * Failures to reach the orchestrator are swallowed: a status hiccup must never
 * crash or block the agent. Hooks lost during a gap are lost, not queued
 * (spec §4.2 out-of-scope: no node-side queue).
 */

/** OpenCode event names Shepherd forwards to its hook endpoint. */
const FORWARDED_EVENTS = new Set([
  // CURRENT OpenCode bus event names (verified against the SDK Event union):
  'session.created', // session start
  'tool.execute.before',
  'tool.execute.after',
  'permission.updated', // approval / awaiting-input (the money state)
  'session.idle', // turn complete
  'session.error',
  'todo.updated', // plan / todo list
  // Telemetry: the assistant message + session objects carry model/tokens/cost
  // (the server extracts it; status is unaffected).
  'message.updated',
  'session.updated',
  // Chat: text streams as message PARTS (message.updated carries only metadata —
  // role/model/tokens, no text). The server assembles parts by message id into the
  // structured Chat tab.
  'message.part.updated',
  // Upstream-version variants retained for mixed current OpenCode installations:
  'session.start',
  'permission.request',
  'question.ask',
  'session.complete',
]);

/**
 * @param {{ type: string, properties?: Record<string, unknown> }} event
 * @returns {Promise<void>}
 */
async function postToFlock(event) {
  const url = process.env.FLOCK_HOOK_URL;
  const token = process.env.FLOCK_HOOK_TOKEN;
  // Without the injected session env this is not a Shepherd-managed session; do
  // nothing rather than error.
  if (!url || !token) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentType: 'opencode', ...event }),
    });
  } catch {
    // Never let a status POST disrupt the agent (dumb courier, best-effort).
  }
}

/**
 * OpenCode plugin entrypoint. OpenCode calls this with a context object and
 * expects a hooks object back. We implement the single `event` hook, which fires
 * for every event on the OpenCode bus, and forward the ones the Shepherd translator
 * understands.
 *
 * @param {{ project?: unknown, client?: unknown, directory?: string, worktree?: string }} _ctx
 */
export const FlockPlugin = async (_ctx) => {
  return {
    /**
     * Fires for every OpenCode bus event.
     * @param {{ event: { type: string, properties?: Record<string, unknown> } }} input
     */
    event: async ({ event }) => {
      if (!event || !FORWARDED_EVENTS.has(event.type)) return;
      await postToFlock(event);
    },
  };
};

export default FlockPlugin;
