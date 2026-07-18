/**
 * Native hook config injection (US-19).
 *
 * THE PROBLEM (PRD open-Q #3): to get first-class lifecycle hooks from Claude
 * Code / Codex / OpenCode we must add hook config to the agent's config, but we
 * must NOT clobber the user's real `~/.claude` / `~/.codex` / `~/.config`.
 *
 * THE SOLUTION (spec §3 "Hook injection", decision row): on session create,
 * merge a narrowly named Shepherd hook file/plugin into the runtime user's native
 * configuration. The installed forwarder is inert unless a Shepherd session supplies
 * its private callback environment, so ordinary agent launches are unaffected.
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
 * The rendered config payload the orchestrator hands to flock-agentd, which
 * seeds it ON THE NODE (T1): agentd writes `files` beneath `configBaseSubdir`
 * and replaces `__FLOCK_CONFIG_DIR__` with the native config path. The
 * orchestrator writes nothing to any filesystem.
 */
export interface RenderedHookConfig {
  files: Record<string, string>;
  /** Agent's real config dir under $HOME (e.g. `.claude`, `.config`) — install target. */
  configBaseSubdir: string;
}

/**
 * POSIX forwarder script that POSTs the agent's hook event (read on stdin) to
 * Shepherd using the env the orchestrator already injects (FLOCK_HOOK_URL/TOKEN). A
 * real script — not an env-var-stuffed command — so shell quoting is correct.
 */
const HOOK_FORWARDER_SH = [
  '#!/bin/sh',
  '# Shepherd hook forwarder (US-19): reads the agent event JSON on stdin, POSTs it.',
  "# No-op outside a Shepherd session: this file is installed in the agent's NATIVE",
  '# config dir, so a plain (non-Shepherd) run of the agent must not error on it.',
  '[ -n "$FLOCK_HOOK_URL" ] && [ -n "$FLOCK_HOOK_TOKEN" ] || exit 0',
  'exec curl -sS -m 5 -X POST "$FLOCK_HOOK_URL" \\',
  '  -H "Authorization: Bearer $FLOCK_HOOK_TOKEN" \\',
  '  -H "content-type: application/json" --data-binary @-',
  '',
].join('\n');

/** Command each agent hook runs — invokes the forwarder in the scoped dir. */
const HOOK_CMD = 'sh __FLOCK_CONFIG_DIR__/flock-hook.sh';

/**
 * Render the hook config for an agent type for agentd to seed on the node.
 * Returns null for agents with no first-class hook config (terminal/dev).
 */
export async function renderHookConfig(agentType: AgentType): Promise<RenderedHookConfig | null> {
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
      // Merge these hooks into the real
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
      // No injected config for codex — its auth + rollout transcript MUST live in the
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
      // Drop the plugin into the real
      // ~/.config/opencode/plugin so opencode uses native auth/config. The plugin
      // already no-ops without FLOCK_HOOK_URL/TOKEN, so non-Shepherd runs are clean.
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
    default:
      return null;
  }
}
