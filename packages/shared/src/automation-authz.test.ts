import { describe, expect, it } from 'vitest';
import {
  CONTROL_CREDENTIAL_ENV_VARS,
  allowAutomation,
  envHasControlCredential,
  type AutomationTokenScope,
} from './automation-authz.js';

describe('allowAutomation', () => {
  const scope: AutomationTokenScope = {
    projectId: 'p1',
    sessionId: 's1',
  };

  it('allows same-project non-admin actions', () => {
    for (const action of ['list', 'prompt', 'wait', 'read', 'keys', 'create'] as const) {
      expect(allowAutomation(scope, action, 'p1')).toBe(true);
    }
  });

  it('denies cross-project', () => {
    expect(allowAutomation(scope, 'prompt', 'p2')).toBe(false);
  });

  it('denies admin even on same project', () => {
    expect(allowAutomation(scope, 'admin', 'p1')).toBe(false);
  });

  it('denies empty project scope or target', () => {
    expect(
      allowAutomation({ projectId: '', sessionId: 's1' }, 'list', 'p1'),
    ).toBe(false);
    expect(allowAutomation(scope, 'list', '')).toBe(false);
  });
});

describe('envHasControlCredential', () => {
  it('returns false for clean env', () => {
    expect(envHasControlCredential(['PATH=/bin', 'HOME=/home/u'])).toBe(false);
  });

  it('detects control credential env vars', () => {
    expect(envHasControlCredential(['FLOCK_AGENTD_SECRET=supersecret'])).toBe(
      true,
    );
    expect(envHasControlCredential(['PATH=/bin', 'FLOCK_MASTER_KEY=x'])).toBe(
      true,
    );
  });

  it('covers the denylist constant', () => {
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_AGENTD_SECRET');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_AGENTD_CREDENTIAL');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('AGENTD_CONTROL_SECRET');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_MASTER_KEY');
    expect(CONTROL_CREDENTIAL_ENV_VARS).toContain('FLOCK_NODE_CREDENTIAL');
  });
});
