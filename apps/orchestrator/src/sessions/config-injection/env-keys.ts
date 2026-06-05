/**
 * Per-agent config-directory environment variables (US-19).
 *
 * Session-scoped hook config injection works by pointing each agent at an
 * ISOLATED, per-session config directory via an env var, instead of editing the
 * user's real config. The agent reads its config from the scoped dir; Flock has
 * layered the user's real config in as a base PLUS its own hook wiring on top,
 * so the user's own files on disk are never touched (spec §3 "Hook injection",
 * open-Q #3, US-19).
 *
 * The exact env var differs per agent:
 *   - Claude Code  → CLAUDE_CONFIG_DIR  (Claude reads settings.json from here)
 *   - Codex        → CODEX_HOME          (Codex reads hooks.toml from here)
 *   - OpenCode     → XDG_CONFIG_HOME     (OpenCode loads plugins from
 *                                         $XDG_CONFIG_HOME/opencode/plugin)
 *   - generic      → (no first-class config dir; hooks come via OSC/PTY, US-20)
 *
 * In addition, every agent's hook command needs to know WHERE to POST and with
 * WHICH per-session token. Those are exposed as Flock-specific env vars that the
 * templated `$FLOCK_HOOK_CMD` forwarder consumes; they thread the SAME
 * session_id that names the tmux session + scopes the hook token + binds the
 * browser endpoint (the single authoritative record, spec §4.2).
 */

/** Env var Claude Code uses to locate its config directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Env var Codex uses to locate its home/config directory. */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/** Env var OpenCode (XDG-conformant) uses to locate its config directory. */
export const XDG_CONFIG_HOME_ENV = 'XDG_CONFIG_HOME';

/**
 * Flock-specific env vars consumed by the templated hook forwarder
 * (`$FLOCK_HOOK_CMD <Event>`). These are injected into EVERY session regardless
 * of agent type so even a generic/OSC session can forward if it wants to.
 */
export const FLOCK_SESSION_ID_ENV = 'FLOCK_SESSION_ID';
export const FLOCK_HOOK_URL_ENV = 'FLOCK_HOOK_URL';
export const FLOCK_HOOK_TOKEN_ENV = 'FLOCK_HOOK_TOKEN';
/** The hook command the templates reference as `$FLOCK_HOOK_CMD <Event>`. */
export const FLOCK_HOOK_CMD_ENV = 'FLOCK_HOOK_CMD';
