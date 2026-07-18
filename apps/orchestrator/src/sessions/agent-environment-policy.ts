import type { AgentType } from '@flock/shared';

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CONTROL_ONLY = new Set([
  'DATABASE_URL',
  'DOCKER_HOST',
  'DOCKER_SOCKET',
  'FLOCK_MASTER_KEY',
  'FLOCK_MASTER_KEY_FILE',
  'FLOCK_AGENTD_SECRET',
  'FLOCK_AGENTD_SECRET_FILE',
  'FLOCK_AGENTD_CREDENTIAL',
  'FLOCK_AGENTD_CREDENTIAL_FILE',
  'FLOCK_AGENTD_NODE_ID_FILE',
  'SESSION_SECRET',
  'SSH_AUTH_SOCK',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
]);

const SESSION_FLOCK_KEYS = new Set([
  'FLOCK_SESSION_ID',
  'FLOCK_HOOK_URL',
  'FLOCK_HOOK_TOKEN',
  'FLOCK_ORCHESTRATE_TOKEN',
]);

/** Known provider secrets are grants to specific coding tools, never fleet-wide env. */
const PROVIDER_GRANTS: Partial<Record<string, ReadonlySet<AgentType>>> = {
  ANTHROPIC_API_KEY: new Set(['claude-code', 'opencode', 'aider']),
  OPENAI_API_KEY: new Set(['codex', 'opencode', 'aider']),
  GEMINI_API_KEY: new Set(['opencode']),
  GOOGLE_API_KEY: new Set(['opencode']),
  XAI_API_KEY: new Set(['grok', 'opencode']),
  CURSOR_API_KEY: new Set(['cursor-agent']),
  AMP_API_KEY: new Set(['amp']),
};

function deniedKey(key: string): boolean {
  return (
    CONTROL_ONLY.has(key) ||
    key.startsWith('DYLD_') ||
    key.startsWith('FLOCK_AGENTD_') ||
    key.startsWith('FLOCK_MASTER_')
  );
}

/** Build the exact explicit agent environment; node values cannot spoof session capabilities. */
export function buildAgentEnvironment(
  agentType: AgentType,
  nodeEnvironment: Readonly<Record<string, string>>,
  sessionEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(nodeEnvironment)) {
    if (!VALID_ENV_NAME.test(key) || deniedKey(key) || key.startsWith('FLOCK_')) continue;
    const grant = PROVIDER_GRANTS[key];
    if (grant && !grant.has(agentType)) continue;
    output[key] = value;
  }
  for (const [key, value] of Object.entries(sessionEnvironment)) {
    if (!VALID_ENV_NAME.test(key) || deniedKey(key)) continue;
    if (key.startsWith('FLOCK_') && !SESSION_FLOCK_KEYS.has(key)) continue;
    output[key] = value;
  }
  return output;
}

export function providerCredentialKeysFor(agentType: AgentType): string[] {
  return Object.entries(PROVIDER_GRANTS)
    .filter(([, allowed]) => allowed?.has(agentType))
    .map(([key]) => key)
    .sort();
}
