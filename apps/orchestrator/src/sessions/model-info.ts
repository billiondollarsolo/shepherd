/**
 * T19 — model context-window limits + pricing, used to turn the agentd-reported
 * raw telemetry (model name + cumulative tokens + current context occupancy) into
 * the numbers a supervisor watches: context-window % (how close to compaction)
 * and an estimated $ cost (how much this run has burned).
 *
 * Matching is by longest prefix on a normalized model id, so version suffixes
 * (`-20251001`, `[1m]`) and minor renames still resolve. Prices are USD per 1M
 * tokens; cost is an ESTIMATE (we only have a cumulative token total from the
 * transcript, not the input/output split, so a blended rate is applied).
 */
import { readFileSync } from 'node:fs';

export interface ModelInfo {
  /** Context window size in tokens. */
  contextLimit: number;
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

const K = 1000;

// Keyed by a model-id PREFIX (lowercased). Longest matching prefix wins.
const MODEL_TABLE: Record<string, ModelInfo> = {
  // Anthropic Claude 4.x. The `[1m]` / `-1m` long-context variants are handled by
  // the explicit 1m keys below (longer prefix → matched first).
  // Opus 4.5+ cut prices to $5/$25 (deprecated Opus 4/4.1 were $15/$75); current
  // models are 4.5–4.8, so price the prefix at the current rate.
  'claude-opus-4': { contextLimit: 200 * K, inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-8[1m]': { contextLimit: 1000 * K, inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-4': { contextLimit: 200 * K, inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-6[1m]': { contextLimit: 1000 * K, inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4': { contextLimit: 200 * K, inputPer1M: 1, outputPer1M: 5 },
  'claude-3-5-haiku': { contextLimit: 200 * K, inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-5-sonnet': { contextLimit: 200 * K, inputPer1M: 3, outputPer1M: 15 },
  // OpenAI / Codex family (approximate public pricing).
  'gpt-5': { contextLimit: 400 * K, inputPer1M: 1.25, outputPer1M: 10 },
  'gpt-4o': { contextLimit: 128 * K, inputPer1M: 2.5, outputPer1M: 10 },
  o4: { contextLimit: 200 * K, inputPer1M: 1.1, outputPer1M: 4.4 },
  o3: { contextLimit: 200 * K, inputPer1M: 2, outputPer1M: 8 },
  codex: { contextLimit: 400 * K, inputPer1M: 1.25, outputPer1M: 10 },
  // Google Gemini 2.5 Pro: $1.25 in / $10 out (≤200k prompt; rises above). We use
  // the ≤200k tier as the estimate.
  'gemini-2': { contextLimit: 1000 * K, inputPer1M: 1.25, outputPer1M: 10 },
  // xAI Grok (grok-build-0.1 / grok-4 / grok-code-*) — ~256k context. grok-build-0.1
  // is ~$1 in / $2 out. Prefix-matched so version suffixes resolve.
  grok: { contextLimit: 256 * K, inputPer1M: 1, outputPer1M: 2 },
};

/** Fallback for an unknown model — a conservative 200k window + mid pricing. */
const DEFAULT_INFO: ModelInfo = { contextLimit: 200 * K, inputPer1M: 3, outputPer1M: 15 };

/**
 * Optional file-over-defaults overrides (configurability, no rebuild): point
 * `FLOCK_MODEL_INFO_FILE` at a JSON object keyed by model-id PREFIX → partial
 * ModelInfo, e.g. `{ "claude-opus-5": { "contextLimit": 500000, "inputPer1M": 5,
 * "outputPer1M": 25 } }`. Overrides MERGE OVER the built-ins (a partial entry
 * inherits the rest from DEFAULT_INFO). Lets ops add new models / adjust prices /
 * set Bedrock-or-enterprise limits without shipping code. Loaded + memoized once;
 * a malformed file is ignored (defaults stand) with a warning.
 */
let effectiveTable: Record<string, ModelInfo> | undefined;
function table(): Record<string, ModelInfo> {
  if (effectiveTable) return effectiveTable;
  effectiveTable = { ...MODEL_TABLE };
  const file = process.env.FLOCK_MODEL_INFO_FILE?.trim();
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<ModelInfo>>;
      for (const [prefix, info] of Object.entries(raw)) {
        effectiveTable[prefix.toLowerCase()] = {
          ...DEFAULT_INFO,
          ...effectiveTable[prefix.toLowerCase()],
          ...info,
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[flock] FLOCK_MODEL_INFO_FILE could not be loaded (${file}); using built-in model table.`,
        err,
      );
    }
  }
  return effectiveTable;
}

/** Test seam: drop the memoized override table so a new env/file is re-read. */
export function resetModelInfoCache(): void {
  effectiveTable = undefined;
}

/** Resolve a model id to its info by longest-prefix match (case-insensitive). */
export function lookupModel(model: string | undefined): ModelInfo {
  if (!model) return DEFAULT_INFO;
  const id = model.toLowerCase();
  let best: ModelInfo | undefined;
  let bestLen = -1;
  for (const [prefix, info] of Object.entries(table())) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = info;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_INFO;
}

/**
 * Context-window occupancy as a 0–100 integer %, or undefined if unknown.
 * Prefers an AGENT-REPORTED limit (`reportedLimit`, e.g. Codex's
 * `model_context_window`) for an exact figure; falls back to the model-info table.
 */
export function contextPct(
  model: string | undefined,
  contextTokens: number | undefined,
  reportedLimit?: number,
): number | undefined {
  if (!contextTokens || contextTokens <= 0) return undefined;
  const limit =
    reportedLimit && reportedLimit > 0 ? reportedLimit : lookupModel(model).contextLimit;
  if (limit <= 0) return undefined;
  return Math.min(100, Math.round((contextTokens / limit) * 100));
}

/**
 * Estimated USD cost for a cumulative token total. We lack the input/output split,
 * so we apply a blended rate weighted toward input (coding sessions are heavily
 * input/cache dominated): 80% input price + 20% output price.
 */
export function estimateCostUsd(
  model: string | undefined,
  totalTokens: number | undefined,
): number | undefined {
  if (!totalTokens || totalTokens <= 0) return undefined;
  const { inputPer1M, outputPer1M } = lookupModel(model);
  const blendedPer1M = inputPer1M * 0.8 + outputPer1M * 0.2;
  const cost = (totalTokens / 1_000_000) * blendedPer1M;
  // Round to 4 dp (sub-cent precision matters for cheap runs).
  return Math.round(cost * 10_000) / 10_000;
}
