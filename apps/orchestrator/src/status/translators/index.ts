/**
 * Per-agent status translators (spec §7.1). Each is a pure function mapping a
 * recorded agent hook payload to the unified {@link Status}; the hook dispatcher
 * (`hooks/translate.ts`) selects one by `agent_type`. Exhaustive, fixture-driven
 * contract tests live beside each translator (US-16 Claude / US-17 Codex /
 * US-18 OpenCode).
 */
export { translateClaudeHook, CLAUDE_AGENT_TYPE, type ClaudeTransition } from './claude.js';
export { translateCodexHook, CODEX_AGENT_TYPE, type CodexTransition } from './codex.js';
export { translateOpenCodeHook, OPENCODE_AGENT_TYPE, type OpenCodeTransition } from './opencode.js';
export { translateGrokHook, GROK_AGENT_TYPE, type GrokTransition } from './grok.js';
export { translateGeminiHook, GEMINI_AGENT_TYPE, type GeminiTransition } from './gemini.js';
