import { describe, expect, it } from 'vitest';

import {
  CONTROL_CREDENTIAL_ENV_VARS,
  allowAutomation,
  envHasControlCredential,
  type AutomationScope,
} from './automation-authz.js';

const scope: AutomationScope = { projectId: 'proj-a', sessionId: 'sess-1' };

describe('allowAutomation (D12)', () => {
  it('allows same-project prompt (and sibling automation actions)', () => {
    expect(allowAutomation(scope, 'prompt', 'proj-a')).toBe(true);
    expect(allowAutomation(scope, 'list', 'proj-a')).toBe(true);
    expect(allowAutomation(scope, 'wait', 'proj-a')).toBe(true);
    expect(allowAutomation(scope, 'read', 'proj-a')).toBe(true);
    expect(allowAutomation(scope, 'keys', 'proj-a')).toBe(true);
    expect(allowAutomation(scope, 'create', 'proj-a')).toBe(true);
  });

  it('denies cross-project actions', () => {
    expect(allowAutomation(scope, 'prompt', 'proj-b')).toBe(false);
    expect(allowAutomation(scope, 'list', 'other')).toBe(false);
  });

  it('denies admin even on the same project', () => {
    expect(allowAutomation(scope, 'admin', 'proj-a')).toBe(false);
  });

  it('denies empty scope or empty target project', () => {
    expect(allowAutomation({ projectId: '', sessionId: 's' }, 'prompt', 'proj-a')).toBe(false);
    expect(allowAutomation(scope, 'prompt', '')).toBe(false);
  });
});

describe('envHasControlCredential', () => {
  it('detects control credential keys in KEY=VAL env lists', () => {
    expect(envHasControlCredential(['PATH=/bin', 'HOME=/home/u'])).toBe(false);
    expect(envHasControlCredential(['FLOCK_AGENTD_SECRET=supersecret'])).toBe(true);
    expect(envHasControlCredential(['FLOCK_MASTER_KEY=x'])).toBe(true);
    expect(envHasControlCredential(['agentd_control_secret=x'])).toBe(true);
    expect(envHasControlCredential(['FLOCK_NODE_CREDENTIAL'])).toBe(true);
  });

  it('lists the canonical banned control credential env vars', () => {
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_AGENTD_SECRET');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_AGENTD_CREDENTIAL');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('AGENTD_CONTROL_SECRET');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_MASTER_KEY');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_NODE_CREDENTIAL');
  });
});
