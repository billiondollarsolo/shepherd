/**
 * OpenCode hook-plugin location (US-19).
 *
 * The Claude settings.json and Codex hooks.toml are NOT templated here — they are
 * built inline by `renderHookConfig` (the agentd-seeded path) and shipped to the
 * node. The OpenCode plugin, by contrast, is a real source file: its authoritative
 * copy is `status/translators/templates/opencode-plugin/flock.js`, which Flock
 * reads verbatim at seed time (single source of truth, no duplicate).
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Filename of the OpenCode plugin inside `$XDG_CONFIG_HOME/opencode/plugin/`. */
export const OPENCODE_PLUGIN_FILENAME = 'flock.js';

/**
 * Absolute path to the authoritative US-18 OpenCode plugin source on disk. Flock
 * copies this verbatim into the scoped `opencode/plugin/` dir; reading from the
 * single source avoids duplicating the plugin logic here.
 */
export function openCodePluginSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // sessions/config-injection -> ../../status/translators/templates/opencode-plugin/flock.js
  return resolve(
    here,
    '..',
    '..',
    'status',
    'translators',
    'templates',
    'opencode-plugin',
    OPENCODE_PLUGIN_FILENAME,
  );
}
