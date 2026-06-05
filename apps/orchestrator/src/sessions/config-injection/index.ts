/**
 * Session-scoped hook config injection (US-19).
 *
 * On session create, seed a per-session isolated config dir (env-pointed:
 * CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME) with Flock's hooks layered
 * over the user's real config WITHOUT clobbering it; remove it on teardown. The
 * scoped dir is keyed by the single authoritative session_id (spec §4.2).
 */
export * from './env-keys.js';
export * from './hook-templates.js';
export * from './config-injection.js';
