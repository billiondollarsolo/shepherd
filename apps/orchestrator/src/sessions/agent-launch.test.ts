import { describe, expect, it } from 'vitest';

import { agentLaunchCommand, initialSessionStatus } from './agent-launch.js';

describe('agentLaunchCommand', () => {
  it('maps each first-class agent to its CLI argv', () => {
    expect(agentLaunchCommand('claude-code')).toEqual(['claude']);
    expect(agentLaunchCommand('codex')).toEqual(['codex']);
    expect(agentLaunchCommand('opencode')).toEqual(['opencode']);
  });

  it('launches a bare default shell (no command) for generic + terminal', () => {
    // undefined => tmux opens its default-shell with no explicit program.
    expect(agentLaunchCommand('generic')).toBeUndefined();
    expect(agentLaunchCommand('terminal')).toBeUndefined();
  });

  it('defaults to no permission flags (interactive) when mode is omitted/default', () => {
    expect(agentLaunchCommand('claude-code', 'default')).toEqual(['claude']);
    expect(agentLaunchCommand('codex', 'default')).toEqual(['codex']);
  });

  it('maps Claude permission modes to its CLI flags', () => {
    expect(agentLaunchCommand('claude-code', 'acceptEdits')).toEqual([
      'claude',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(agentLaunchCommand('claude-code', 'plan')).toEqual([
      'claude',
      '--permission-mode',
      'plan',
    ]);
    expect(agentLaunchCommand('claude-code', 'autonomous')).toEqual([
      'claude',
      '--dangerously-skip-permissions',
    ]);
  });

  it('maps Codex permission modes to its sandbox/approval flags', () => {
    expect(agentLaunchCommand('codex', 'acceptEdits')).toEqual(['codex', '--sandbox', 'workspace-write']);
    expect(agentLaunchCommand('codex', 'plan')).toEqual([
      'codex',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
    ]);
    expect(agentLaunchCommand('codex', 'autonomous')).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('ignores permission mode for opencode/generic/terminal (no launch flags)', () => {
    expect(agentLaunchCommand('opencode', 'autonomous')).toEqual(['opencode']);
    expect(agentLaunchCommand('generic', 'autonomous')).toBeUndefined();
    expect(agentLaunchCommand('terminal', 'autonomous')).toBeUndefined();
  });

  it('maps Gemini permission modes to its approval flags (T20)', () => {
    expect(agentLaunchCommand('gemini')).toEqual(['gemini']);
    expect(agentLaunchCommand('gemini', 'default')).toEqual(['gemini']);
    expect(agentLaunchCommand('gemini', 'plan')).toEqual(['gemini', '--approval-mode', 'plan']);
    expect(agentLaunchCommand('gemini', 'acceptEdits')).toEqual([
      'gemini',
      '--approval-mode',
      'auto_edit',
    ]);
    expect(agentLaunchCommand('gemini', 'autonomous')).toEqual(['gemini', '--yolo']);
  });

  it('wraps Grok in an auth-then-run shell: device-code login only if unauthed', () => {
    const cmd = agentLaunchCommand('grok');
    expect(cmd?.[0]).toBe('sh');
    expect(cmd?.[1]).toBe('-c');
    const script = cmd?.[2] ?? '';
    // probe (already authed?) → else device-code login → exec the agent
    expect(script).toContain('$HOME/.grok/auth.json');
    expect(script).toContain('$XAI_API_KEY');
    expect(script).toContain('grok login --device-auth');
    expect(script).toMatch(/exec grok$/);
    // an authed node short-circuits the login via `||`, then `; exec` runs the agent
    expect(script).toContain('|| grok login --device-auth; exec grok');
  });
});

describe('initialSessionStatus', () => {
  it('starts agent sessions at "starting" (their hooks advance them)', () => {
    expect(initialSessionStatus('claude-code')).toBe('starting');
    expect(initialSessionStatus('codex')).toBe('starting');
    expect(initialSessionStatus('opencode')).toBe('starting');
    expect(initialSessionStatus('generic')).toBe('starting');
  });

  it('starts a hook-less terminal at "running" (the shell is up immediately)', () => {
    // Otherwise it would sit at "starting" forever — nothing reports for a shell.
    expect(initialSessionStatus('terminal')).toBe('running');
  });

  it('starts gemini at "starting" (its v0.26+ hooks advance it, like the other agents)', () => {
    expect(initialSessionStatus('gemini')).toBe('starting');
  });
});

describe('agent capability table', () => {
  it('agentSessionKind maps to the daemon kind', async () => {
    const { agentSessionKind } = await import('./agent-launch.js');
    expect(agentSessionKind('claude-code')).toBe('agent');
    expect(agentSessionKind('gemini')).toBe('agent');
    expect(agentSessionKind('terminal')).toBe('shell');
    expect(agentSessionKind('dev')).toBe('dev');
  });

  it('agentUsesActivityStatus only for generic (gemini now uses its v0.26+ hooks)', async () => {
    const { agentUsesActivityStatus } = await import('./agent-launch.js');
    expect(agentUsesActivityStatus('generic')).toBe(true);
    expect(agentUsesActivityStatus('gemini')).toBe(false);
    expect(agentUsesActivityStatus('claude-code')).toBe(false);
    expect(agentUsesActivityStatus('codex')).toBe(false);
    expect(agentUsesActivityStatus('opencode')).toBe(false);
    expect(agentUsesActivityStatus('terminal')).toBe(false);
  });
});
