import { describe, expect, it } from 'vitest';

import { buildAgentEnvironment, providerCredentialKeysFor } from './agent-environment-policy.js';

describe('agent environment policy', () => {
  it('drops control-plane, loader, malformed, and spoofed Flock variables', () => {
    const env = buildAgentEnvironment(
      'claude-code',
      {
        DATABASE_URL: 'postgres://secret',
        DOCKER_SOCKET: '/var/run/docker.sock',
        LD_PRELOAD: '/tmp/evil.so',
        FLOCK_HOOK_TOKEN: 'spoofed',
        'BAD-NAME': 'bad',
        PUBLIC_FLAG: 'ok',
      },
      { FLOCK_SESSION_ID: 'session-a', FLOCK_HOOK_TOKEN: 'real' },
    );
    expect(env).toEqual({
      PUBLIC_FLAG: 'ok',
      FLOCK_SESSION_ID: 'session-a',
      FLOCK_HOOK_TOKEN: 'real',
    });
  });

  it('grants known provider credentials only to compatible tools', () => {
    const node = {
      ANTHROPIC_API_KEY: 'anthropic',
      OPENAI_API_KEY: 'openai',
      GEMINI_API_KEY: 'gemini',
    };
    expect(buildAgentEnvironment('claude-code', node, {})).toEqual({
      ANTHROPIC_API_KEY: 'anthropic',
    });
    expect(buildAgentEnvironment('codex', node, {})).toEqual({ OPENAI_API_KEY: 'openai' });
    expect(buildAgentEnvironment('opencode', node, {})).toEqual(node);
    expect(providerCredentialKeysFor('gemini')).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  });

  it('allows only the explicit session capability variables', () => {
    expect(
      buildAgentEnvironment(
        'codex',
        {},
        {
          FLOCK_SESSION_ID: 's',
          FLOCK_ORCHESTRATE_TOKEN: 'token',
          FLOCK_AGENTD_SECRET: 'no',
          FLOCK_UNKNOWN: 'no',
        },
      ),
    ).toEqual({ FLOCK_SESSION_ID: 's', FLOCK_ORCHESTRATE_TOKEN: 'token' });
  });
});
