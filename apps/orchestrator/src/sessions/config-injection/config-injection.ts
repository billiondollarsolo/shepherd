/**
 * Session-scoped hook config injection (US-19).
 *
 * THE PROBLEM (PRD open-Q #3): to get first-class lifecycle hooks from Claude
 * Code / Codex / OpenCode we must add hook config to the agent's config, but we
 * must NOT clobber the user's real `~/.claude` / `~/.codex` / `~/.config`.
 *
 * THE SOLUTION (spec §3 "Hook injection", decision row): on session create,
 * seed a PER-SESSION isolated config directory, layer the user's real config in
 * as a read-only base, then overlay ONLY Flock's hook wiring on top. Point the
 * agent at the scoped dir via an env var (CLAUDE_CONFIG_DIR / CODEX_HOME /
 * XDG_CONFIG_HOME). On teardown, remove the scoped dir. The user's own files are
 * never written to — only READ (copied) — so they are provably untouched.
 *
 * This is reversible and isolated:
 *   - reversible: nothing on the user's real config path is mutated;
 *   - isolated:   the scoped dir is keyed by the SINGLE session_id (spec §4.2),
 *                 the same id that names the tmux session, scopes the hook
 *                 token, and binds the browser endpoint — so it tears down with
 *                 the rest of the session's resources and never collides.
 *
 * DUMB NODES (spec §6.4): this is orchestrator-side logic. The node never runs
 * any of it; it only ever runs the argv the orchestrator hands it, with the
 * scoped-config env merged in by the caller. Hooks POST back to the orchestrator
 * over the loopback reverse tunnel using the per-session token.
 */
import { readFile } from 'node:fs/promises';

import type { AgentType } from '@flock/shared';

import { OPENCODE_PLUGIN_FILENAME, openCodePluginSourcePath } from './hook-templates.js';

/**
 * The rendered scoped-config payload the orchestrator hands to flock-agentd, which
 * seeds it ON THE NODE (T1): agentd creates the dir, copies the node user's real
 * config (`configBaseSubdir`), writes `files` (replacing the literal
 * `__FLOCK_CONFIG_DIR__` placeholder with the scoped dir path), and exports
 * `configDirEnv`=<dir> to the agent. Works uniformly for local + SSH nodes — the
 * orchestrator writes nothing to any filesystem.
 */
export interface RenderedScopedConfig {
  /**
   * The env var that redirects the agent's config dir to a per-session SCOPED copy
   * (legacy isolation). OMITTED for the NATIVE model: Flock installs its hook files
   * directly into the agent's real config dir (`configBaseSubdir`) and does NOT
   * override the config dir — so the agent uses its native config + auth + transcript
   * (the node is treated as a pre-configured machine). Hooks no-op without the
   * per-session FLOCK_HOOK_* env, so a non-Flock run of the agent is unaffected.
   */
  configDirEnv?: string;
  files: Record<string, string>;
  /** Agent's real config dir under $HOME (e.g. `.claude`, `.config`) — install target. */
  configBaseSubdir: string;
}

/**
 * POSIX forwarder script that POSTs the agent's hook event (read on stdin) to
 * Flock using the env the orchestrator already injects (FLOCK_HOOK_URL/TOKEN). A
 * real script — not an env-var-stuffed command — so shell quoting is correct.
 */
const HOOK_FORWARDER_SH = [
  '#!/bin/sh',
  '# Flock hook forwarder (US-19): reads the agent event JSON on stdin, POSTs it.',
  "# No-op outside a Flock session: this file is installed in the agent's NATIVE",
  '# config dir, so a plain (non-Flock) run of the agent must not error on it.',
  '[ -n "$FLOCK_HOOK_URL" ] && [ -n "$FLOCK_HOOK_TOKEN" ] || exit 0',
  'exec curl -sS -m 5 -X POST "$FLOCK_HOOK_URL" \\',
  '  -H "Authorization: Bearer $FLOCK_HOOK_TOKEN" \\',
  '  -H "content-type: application/json" --data-binary @-',
  '',
].join('\n');

/** Command each agent hook runs — invokes the forwarder in the scoped dir. */
const HOOK_CMD = 'sh __FLOCK_CONFIG_DIR__/flock-hook.sh';

/**
 * Render the scoped hook-config for an agent type for agentd to seed on the node.
 * Returns null for agents with no first-class hook config (generic/terminal/dev).
 */
export async function renderScopedConfig(
  agentType: AgentType,
): Promise<RenderedScopedConfig | null> {
  switch (agentType) {
    case 'claude-code': {
      const settings = {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PostToolUseFailure: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          Notification: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          Stop: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          // Genuine session end -> done (the "session finished" Web Push).
          SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
        },
      };
      // NATIVE install (no configDirEnv): merge these hooks into the real
      // ~/.claude so claude uses native auth/transcript/onboarding. The merge
      // preserves the user's own hooks; the forwarder no-ops without FLOCK_HOOK_*.
      return {
        configBaseSubdir: '.claude',
        files: {
          'settings.json': JSON.stringify(settings, null, 2),
          'flock-hook.sh': HOOK_FORWARDER_SH,
        },
      };
    }
    case 'codex':
      // NO scoped config for codex — its auth + rollout transcript MUST live in the
      // real ~/.codex (scoping CODEX_HOME stranded `codex login` creds in a throwaway
      // dir and hid the rollout from the daemon's tailer). Status/tokens/model/plan
      // are transcript-derived (the daemon tails ~/.codex/sessions), which is solid.
      //
      // Current Codex DOES now ship Claude-style hooks (incl. a `PermissionRequest`
      // event → the missing `awaiting_input` signal), and the shared schema +
      // `codex.ts` translator are READY to receive them (tolerant of both
      // `hook_event_name`/`event` shapes). Seeding is deliberately deferred: it would
      // mean merging a `[hooks]` block into the user's real ~/.codex/config.toml,
      // and the exact on-disk format hasn't been validated against a live authed
      // codex — writing an unverified block into the dir that holds their auth is the
      // one change we won't make blind. Enable once a real codex hook payload is
      // captured on a node (then add the configBaseSubdir '.codex' files here).
      return null;
    case 'opencode': {
      // NATIVE install (no configDirEnv): drop the plugin into the real
      // ~/.config/opencode/plugin so opencode uses native auth/config. The plugin
      // already no-ops without FLOCK_HOOK_URL/TOKEN, so non-Flock runs are clean.
      const plugin = await readFile(openCodePluginSourcePath(), 'utf8');
      return {
        configBaseSubdir: '.config',
        files: { [`opencode/plugin/${OPENCODE_PLUGIN_FILENAME}`]: plugin },
      };
    }
    case 'grok': {
      // NATIVE install: a dedicated hook file at ~/.grok/hooks/flock.json (global
      // grok hooks are "always trusted" — no /hooks-trust prompt — and live in
      // their own file, so this doesn't touch the user's config.toml). Grok fires
      // these Claude-style lifecycle events with its own payload shape; the Grok
      // translator maps them. This makes hook status RELIABLE instead of depending
      // on grok's incidental claude-compat scan of ~/.claude. Forwarder no-ops
      // without FLOCK_HOOK_*. (We skip Notification: it's grok's per-hook-execution
      // meta = pure noise.)
      const grokHooks = {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          PostToolUseFailure: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          Stop: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          // Genuine session end -> done (the "session finished" Web Push).
          SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
        },
      };
      return {
        configBaseSubdir: '.grok',
        files: {
          'hooks/flock.json': JSON.stringify(grokHooks, null, 2),
          'flock-hook.sh': HOOK_FORWARDER_SH,
        },
      };
    }
    case 'gemini': {
      // NATIVE install: merge Flock's hooks into the real ~/.gemini/settings.json
      // (the generic JSON deep-merge in the daemon preserves the user's gemini
      // config). Gemini CLI v0.26.0+ fires Claude-Code-style lifecycle hooks with
      // the SAME settings.json shape — so this lifts gemini from the old PTY-activity
      // heuristic to real running/awaiting_input/idle/done (the gemini translator
      // maps them). Forwarder no-ops without FLOCK_HOOK_*.
      const settings = {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          BeforeAgent: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          BeforeTool: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          AfterTool: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          Notification: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          AfterAgent: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
        },
      };
      return {
        configBaseSubdir: '.gemini',
        files: {
          'settings.json': JSON.stringify(settings, null, 2),
          'flock-hook.sh': HOOK_FORWARDER_SH,
        },
      };
    }
    default:
      return null;
  }
}
