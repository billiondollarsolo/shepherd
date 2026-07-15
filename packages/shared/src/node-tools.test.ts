import { describe, expect, it } from 'vitest';

import {
  ConfigureNodeDockerRequestSchema,
  InstallNodeToolRequestSchema,
  NODE_TOOL_CATALOG,
  nodeToolDefinition,
} from './index.js';

describe('node tool catalog', () => {
  it('contains every launchable coding tool exactly once', () => {
    expect(NODE_TOOL_CATALOG.map((tool) => tool.id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'grok',
      'aider',
      'cursor-agent',
      'amp',
    ]);
    expect(new Set(NODE_TOOL_CATALOG.map((tool) => tool.agentType)).size).toBe(8);
    expect(NODE_TOOL_CATALOG.filter((tool) => tool.integration === 'first_class')).toHaveLength(5);
    expect(NODE_TOOL_CATALOG.filter((tool) => tool.integration === 'basic')).toHaveLength(3);
    expect(nodeToolDefinition('amp').binary).toBe('amp');
  });

  it('rejects unknown tools and anything short of exact confirmation', () => {
    expect(
      InstallNodeToolRequestSchema.safeParse({ tool: 'amp', confirm: 'INSTALL' }).success,
    ).toBe(true);
    expect(InstallNodeToolRequestSchema.safeParse({ tool: 'amp', confirm: 'yes' }).success).toBe(
      false,
    );
    expect(
      InstallNodeToolRequestSchema.safeParse({ tool: 'unsupported', confirm: 'INSTALL' }).success,
    ).toBe(false);
  });

  it('requires a stronger confirmation before granting root-equivalent Docker access', () => {
    expect(
      ConfigureNodeDockerRequestSchema.safeParse({
        action: 'install',
        confirm: 'INSTALL DOCKER',
      }).success,
    ).toBe(true);
    expect(
      ConfigureNodeDockerRequestSchema.safeParse({
        action: 'enable_agent_access',
        confirm: 'INSTALL DOCKER',
      }).success,
    ).toBe(false);
    expect(
      ConfigureNodeDockerRequestSchema.safeParse({
        action: 'enable_agent_access',
        confirm: 'DOCKER IS ROOT EQUIVALENT',
      }).success,
    ).toBe(true);
  });
});
