import type { AgentType } from './domain.js';
import type { NodeToolId, NodeToolIntegration } from './contracts/nodes.js';

export interface NodeToolDefinition {
  id: NodeToolId;
  agentType: AgentType;
  label: string;
  binary: string;
  integration: NodeToolIntegration;
  documentationUrl: string;
}

/**
 * Canonical inventory of coding-agent CLIs Shepherd can launch. Terminal and
 * dev sessions are intentionally absent because they require no external tool.
 */
export const NODE_TOOL_CATALOG: readonly NodeToolDefinition[] = [
  {
    id: 'claude',
    agentType: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    integration: 'first_class',
    documentationUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  },
  {
    id: 'codex',
    agentType: 'codex',
    label: 'Codex',
    binary: 'codex',
    integration: 'first_class',
    documentationUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'opencode',
    agentType: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    integration: 'first_class',
    documentationUrl: 'https://opencode.ai/docs',
  },
  {
    id: 'gemini',
    agentType: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    integration: 'first_class',
    documentationUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'grok',
    agentType: 'grok',
    label: 'Grok Build',
    binary: 'grok',
    integration: 'first_class',
    documentationUrl: 'https://docs.x.ai/build/overview',
  },
  {
    id: 'aider',
    agentType: 'aider',
    label: 'Aider',
    binary: 'aider',
    integration: 'basic',
    documentationUrl: 'https://aider.chat/docs/install.html',
  },
  {
    id: 'cursor-agent',
    agentType: 'cursor-agent',
    label: 'Cursor Agent',
    binary: 'cursor-agent',
    integration: 'basic',
    documentationUrl: 'https://docs.cursor.com/en/cli/installation',
  },
  {
    id: 'amp',
    agentType: 'amp',
    label: 'Amp',
    binary: 'amp',
    integration: 'basic',
    documentationUrl: 'https://ampcode.com/manual',
  },
] as const;

export function nodeToolDefinition(id: NodeToolId): NodeToolDefinition {
  const definition = NODE_TOOL_CATALOG.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown node tool: ${id}`);
  return definition;
}
