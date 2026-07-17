/**
 * Model catalogs for the New-Session + chat-header model picker.
 *
 * Two sources:
 *   - Antigravity (`agy`) is DISCOVERED live on the node — `agy models` prints one
 *     model per line, and the effort/speed is baked into the name, e.g.
 *     "Claude Opus 4.6 (Thinking)" / "Gemini 3.5 Flash (High)". Those exact strings
 *     are the `--model` values.
 *   - Other agents get a curated STATIC list of `--model` values known to work with
 *     that CLI. The web also allows a free-text model, so a stale static entry is a
 *     convenience list, not a hard constraint.
 *
 * Pure + unit-tested: the service just runs the command and calls the parser.
 */
import type { AgentType } from '@flock/shared';

/** Parse the stdout of `agy models` into `--model` values (one per non-empty line). */
export function parseAgyModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The two ndjson JSON-RPC lines we feed to a one-shot `codex app-server` on stdin to
 * discover its DYNAMIC model list: an `initialize` handshake (no auth needed) followed
 * by `model/list`. The app-server answers each on its own stdout line
 * (`{"id":1,"result":{...}}`, `{"id":2,"result":{"data":[...]}}`), interleaved with
 * harmless notifications. Exported so the discovery helper (and its test) share the
 * exact wire bytes.
 */
export const CODEX_MODEL_LIST_REQUESTS: readonly [string, string] = [
  JSON.stringify({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'flock-orchestrator', version: '1' } },
  }),
  JSON.stringify({ id: 2, method: 'model/list', params: {} }),
];

/**
 * Parse the stdout of a one-shot `codex app-server` model/list exchange into `--model`
 * values. The stream is newline-delimited JSON-RPC; we scan each line for the
 * `model/list` RESPONSE (a `result.data[]` array of Models, per the version-exact
 * ModelListResponse schema) and extract each model's stable `id` (falling back to
 * `model`). De-duplicated, order-preserving. Non-JSON lines, notifications, the
 * `initialize` response, and stderr noise (the bubblewrap warning) are ignored, so an
 * unauthenticated codex (empty `data`) yields `[]` and the caller degrades to static.
 */
export function parseCodexModelList(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const data = (msg as { result?: { data?: unknown } })?.result?.data;
    if (!Array.isArray(data)) continue;
    for (const entry of data) {
      const m = entry as { id?: unknown; model?: unknown };
      const id = (typeof m.id === 'string' && m.id) || (typeof m.model === 'string' && m.model) || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Curated `--model` suggestions per agent for CLIs without a machine-readable model
 * list. Conservative on purpose (values known to resolve); the picker also accepts
 * a custom value. Antigravity is intentionally absent (discovered on the node).
 */
export const STATIC_AGENT_MODELS: Partial<Record<AgentType, readonly string[]>> = {
  // Claude Code `--model` accepts short aliases for the latest of each family
  // (verified from `claude --help`: "an alias … e.g. 'fable', 'opus', or 'sonnet'")
  // or a full model id (e.g. 'claude-fable-5'). There is NO CLI enumeration of the
  // full descriptive list the TUI /model shows, so this is a curated set of aliases;
  // the picker also accepts free-text for any exact model id.
  'claude-code': ['fable', 'opus', 'sonnet', 'haiku'],
  // Codex `--model` (its main quality knob is reasoning-effort, offered separately).
  codex: ['gpt-5-codex', 'gpt-5'],
};

/** The static model list for an agent, or [] when it has no curated catalog. */
export function staticModelsFor(agentType: AgentType): string[] {
  return [...(STATIC_AGENT_MODELS[agentType] ?? [])];
}

/** Whether this agent's models are discovered live on the node (vs static). */
export function isNodeDiscoveredModels(agentType: AgentType): boolean {
  return agentType === 'antigravity' || agentType === 'codex';
}
