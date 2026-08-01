/**
 * Project-scoped automation authorization (D12).
 * Canonical implementation lives in `@flock/shared` — re-export so routes and
 * tests always exercise the shipped shared functions.
 */
import {
  allowAutomation as sharedAllow,
  envHasControlCredential,
  CONTROL_CREDENTIAL_ENV_VARS,
  type AutomationTokenScope,
  type AutomationAction,
} from '@flock/shared';

export {
  envHasControlCredential,
  CONTROL_CREDENTIAL_ENV_VARS,
  type AutomationTokenScope,
  type AutomationAction,
};

/** Alias used by automation-service and routes. */
export type AutomationScope = AutomationTokenScope;

/**
 * Same-project only; admin always denied. Accepts string action for route
 * call sites; unknown non-admin actions are treated as denied only if not
 * in the shared union — shared checks project equality for known actions.
 */
export function allowAutomation(
  scope: AutomationTokenScope | AutomationScope,
  action: string,
  targetProjectId: string,
): boolean {
  const known: AutomationAction[] = [
    'list',
    'prompt',
    'wait',
    'read',
    'keys',
    'create',
    'admin',
  ];
  if (!known.includes(action as AutomationAction)) {
    // Treat unknown actions as denied (fail closed).
    return false;
  }
  return sharedAllow(scope, action as AutomationAction, targetProjectId);
}
