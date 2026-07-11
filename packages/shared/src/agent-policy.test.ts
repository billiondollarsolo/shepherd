import { describe, expect, it } from 'vitest';

import {
  agentAuthorityScopes,
  authorityAllows,
  DEFAULT_PROJECT_AGENT_POLICY,
  ProjectAgentPolicySchema,
} from './domain.js';

describe('project agent policy', () => {
  it('maps authority tiers monotonically to explicit capabilities', () => {
    expect(agentAuthorityScopes('callback_only')).toEqual([]);
    expect(agentAuthorityScopes('observe')).toEqual(['agents:list:project', 'agents:read:project']);
    expect(agentAuthorityScopes('manage')).toContain('agents:terminate:project');
    expect(authorityAllows('collaborate', 'observe')).toBe(true);
    expect(authorityAllows('observe', 'delegate')).toBe(false);
  });

  it('defaults to no agent-to-agent authority', () => {
    expect(DEFAULT_PROJECT_AGENT_POLICY.defaultAuthority).toBe('callback_only');
    expect(ProjectAgentPolicySchema.parse(DEFAULT_PROJECT_AGENT_POLICY)).toEqual(
      DEFAULT_PROJECT_AGENT_POLICY,
    );
  });

  it('rejects invalid bounds and a default above the maximum', () => {
    expect(
      ProjectAgentPolicySchema.safeParse({
        ...DEFAULT_PROJECT_AGENT_POLICY,
        defaultAuthority: 'manage',
        maxAuthority: 'observe',
      }).success,
    ).toBe(false);
    expect(
      ProjectAgentPolicySchema.safeParse({
        ...DEFAULT_PROJECT_AGENT_POLICY,
        maxSendBytes: 10_000_000,
      }).success,
    ).toBe(false);
  });
});
