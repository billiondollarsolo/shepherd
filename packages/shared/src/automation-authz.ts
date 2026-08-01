/**
 * Project-scoped automation token authorization (D12) and control-credential
 * env denylist — pure helpers mirroring `agentd/internal/agentcontrol`.
 */

/** Scope bound to an automation token at mint time. */
export interface AutomationTokenScope {
  projectId: string;
  sessionId: string;
}

/** Control actions an automation token may request. */
export type AutomationAction =
  | 'list'
  | 'prompt'
  | 'wait'
  | 'read'
  | 'keys'
  | 'create'
  | 'admin';

/**
 * Whether the token may perform `action` on `targetProjectId`.
 * Same project only; `admin` is always denied for automation tokens;
 * empty project ids are denied.
 */
export function allowAutomation(
  scope: AutomationTokenScope,
  action: AutomationAction,
  targetProjectId: string,
): boolean {
  if (!scope.projectId || !targetProjectId) {
    return false;
  }
  if (action === 'admin') {
    return false;
  }
  return scope.projectId === targetProjectId;
}

/**
 * Env var names that must never appear in agent environments (control secrets).
 */
export const CONTROL_CREDENTIAL_ENV_VARS = [
  'FLOCK_AGENTD_SECRET',
  'FLOCK_AGENTD_CREDENTIAL',
  'AGENTD_CONTROL_SECRET',
  'FLOCK_MASTER_KEY',
  'FLOCK_NODE_CREDENTIAL',
] as const;

/**
 * True if `env` (KEY=VAL entries) leaks any control credential name.
 * Comparison is case-insensitive on the key.
 */
export function envHasControlCredential(env: string[]): boolean {
  for (const entry of env) {
    const eq = entry.indexOf('=');
    const key = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    for (const banned of CONTROL_CREDENTIAL_ENV_VARS) {
      if (key.toLowerCase() === banned.toLowerCase()) {
        return true;
      }
    }
  }
  return false;
}
