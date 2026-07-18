import { describe, expect, it } from 'vitest';

import {
  agentLaunchCommand,
  agentResumeArgs,
  claudeStreamLaunchCommand,
  codexAppServerLaunchCommand,
  initialSessionStatus,
} from './agent-launch.js';

describe('agentLaunchCommand', () => {
  it('maps each first-class agent to its CLI argv', () => {
    expect(agentLaunchCommand('claude-code')).toEqual(['claude']);
    expect(agentLaunchCommand('codex')).toEqual(['codex']);
    expect(agentLaunchCommand('opencode')).toEqual(['opencode']);
  });

  it('launches a bare default shell (no command) for terminal', () => {
    // undefined => tmux opens its default-shell with no explicit program.
    expect(agentLaunchCommand('terminal')).toBeUndefined();
  });

  it('appends --model for agents with a model flag (value with spaces stays one arg)', () => {
    expect(agentLaunchCommand('claude-code', 'default', undefined, 'opus')).toEqual([
      'claude',
      '--model',
      'opus',
    ]);
    // agy model names carry the effort in parens; the array arg needs no quoting.
    expect(
      agentLaunchCommand('antigravity', 'default', undefined, 'Claude Opus 4.6 (Thinking)'),
    ).toEqual(['agy', '--model', 'Claude Opus 4.6 (Thinking)']);
  });

  it('maps codex reasoning-effort to a config override, skipping default', () => {
    expect(agentLaunchCommand('codex', 'default', undefined, 'gpt-5', 'high')).toEqual([
      'codex',
      '--model',
      'gpt-5',
      '-c',
      'model_reasoning_effort=high',
    ]);
    expect(agentLaunchCommand('codex', 'default', undefined, undefined, 'default')).toEqual([
      'codex',
    ]);
  });

  it('does not add --model for agents without a model flag (opencode)', () => {
    expect(agentLaunchCommand('opencode', 'default', undefined, 'whatever')).toEqual(['opencode']);
  });

  it('appends extraArgs verbatim (e.g. a resume flag on model-switch relaunch)', () => {
    expect(
      agentLaunchCommand(
        'antigravity',
        'default',
        undefined,
        'Claude Opus 4.6 (Thinking)',
        undefined,
        ['--continue'],
      ),
    ).toEqual(['agy', '--model', 'Claude Opus 4.6 (Thinking)', '--continue']);
  });

  it('ends with the resume flag when relaunching with agentResumeArgs (antigravity)', () => {
    expect(
      agentLaunchCommand(
        'antigravity',
        'default',
        undefined,
        'X',
        undefined,
        agentResumeArgs('antigravity'),
      ),
    ).toEqual(['agy', '--model', 'X', '--continue']);
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
    expect(agentLaunchCommand('codex', 'acceptEdits')).toEqual([
      'codex',
      '--sandbox',
      'workspace-write',
    ]);
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

  it('ignores permission mode for opencode/terminal (no launch flags)', () => {
    expect(agentLaunchCommand('opencode', 'autonomous')).toEqual(['opencode']);
    expect(agentLaunchCommand('terminal', 'autonomous')).toBeUndefined();
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
  });

  it('starts a hook-less terminal at "running" (the shell is up immediately)', () => {
    // Otherwise it would sit at "starting" forever — nothing reports for a shell.
    expect(initialSessionStatus('terminal')).toBe('running');
  });
});

describe('agent capability table', () => {
  it('agentSessionKind maps to the daemon kind', async () => {
    const { agentSessionKind } = await import('./agent-launch.js');
    expect(agentSessionKind('claude-code')).toBe('agent');
    expect(agentSessionKind('terminal')).toBe('shell');
    expect(agentSessionKind('dev')).toBe('dev');
  });

  it('agentUsesActivityStatus follows explicit per-agent status capabilities', async () => {
    const { agentUsesActivityStatus } = await import('./agent-launch.js');
    expect(agentUsesActivityStatus('aider')).toBe(true);
    expect(agentUsesActivityStatus('claude-code')).toBe(false);
    expect(agentUsesActivityStatus('codex')).toBe(false);
    expect(agentUsesActivityStatus('opencode')).toBe(false);
    expect(agentUsesActivityStatus('terminal')).toBe(false);
  });

  it('agentResumeArgs returns the resume flag only for agents whose CLI can resume', () => {
    expect(agentResumeArgs('antigravity')).toEqual(['--continue']);
    expect(agentResumeArgs('claude-code')).toEqual(['--continue']);
    // codex/others relaunch fresh (no resume flag).
    expect(agentResumeArgs('codex')).toEqual([]);
  });

  describe('claudeStreamLaunchCommand', () => {
    const base = [
      'claude',
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
    ];

    it('returns null for every non-claude agent (PTY/ACP path unchanged)', () => {
      expect(claudeStreamLaunchCommand('codex')).toBeNull();
      expect(claudeStreamLaunchCommand('opencode')).toBeNull();
      expect(claudeStreamLaunchCommand('terminal')).toBeNull();
      expect(claudeStreamLaunchCommand('dev')).toBeNull();
    });

    it('gates default via the stdio permission-prompt-tool (no auto-run, no permission-mode flag)', () => {
      expect(claudeStreamLaunchCommand('claude-code', 'default')).toEqual([...base]);
    });

    it('passes plan/acceptEdits through with the prompt-tool flag still present', () => {
      expect(claudeStreamLaunchCommand('claude-code', 'plan')).toEqual([
        ...base,
        '--permission-mode',
        'plan',
      ]);
      expect(claudeStreamLaunchCommand('claude-code', 'acceptEdits')).toEqual([
        ...base,
        '--permission-mode',
        'acceptEdits',
      ]);
    });

    it('autonomous skips approval entirely — no prompt-tool flag (mutually exclusive)', () => {
      // base intentionally excluded: --dangerously-skip-permissions must NOT be combined
      // with --permission-prompt-tool stdio.
      expect(claudeStreamLaunchCommand('claude-code', 'autonomous')).toEqual([
        'claude',
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ]);
    });

    it('appends --model when a model is given', () => {
      expect(claudeStreamLaunchCommand('claude-code', 'plan', 'opus')).toEqual([
        ...base,
        '--permission-mode',
        'plan',
        '--model',
        'opus',
      ]);
    });
  });

  describe('codexAppServerLaunchCommand', () => {
    it('returns the app-server argv for codex only', () => {
      expect(codexAppServerLaunchCommand('codex')).toEqual(['codex', 'app-server']);
    });

    it('returns null for every non-codex agent (no launch flags — approvals ride the protocol)', () => {
      expect(codexAppServerLaunchCommand('claude-code')).toBeNull();
      expect(codexAppServerLaunchCommand('antigravity')).toBeNull();
      expect(codexAppServerLaunchCommand('opencode')).toBeNull();
      expect(codexAppServerLaunchCommand('terminal')).toBeNull();
      expect(codexAppServerLaunchCommand('dev')).toBeNull();
    });
  });

  it('isBareAgentProcessName catches TUI process names (not real tools)', async () => {
    const { isBareAgentProcessName } = await import('./agent-launch.js');
    expect(isBareAgentProcessName('grok')).toBe(true);
    expect(isBareAgentProcessName('/usr/bin/grok')).toBe(true);
    expect(isBareAgentProcessName('opencode')).toBe(true);
    expect(isBareAgentProcessName('Bash')).toBe(false);
    expect(isBareAgentProcessName('Edit')).toBe(false);
    expect(isBareAgentProcessName(null)).toBe(false);
  });
});
