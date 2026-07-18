import { describe, it, expect } from 'vitest';
import { renderHookConfig } from './config-injection.js';
import { OPENCODE_PLUGIN_FILENAME } from './hook-templates.js';

// renderHookConfig is the live path: it returns the files + native config target for
// agentd to seed ON THE NODE (no orchestrator-fs writes).
describe('renderHookConfig (agentd-seeded native hook config)', () => {
  it('claude-code: settings.json + forwarder in native .claude config', async () => {
    const r = await renderHookConfig('claude-code');
    expect(r).not.toBeNull();
    // NATIVE: no config-dir override → claude uses its real config + auth.
    expect(r!.configBaseSubdir).toBe('.claude');
    expect(Object.keys(r!.files)).toEqual(
      expect.arrayContaining(['settings.json', 'flock-hook.sh']),
    );
    const settings = JSON.parse(r!.files['settings.json']!);
    // Wires the lifecycle events the Claude translator understands, incl. the
    // money state's source (Notification → awaiting_input).
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']),
    );
    // The hook command runs the forwarder script via the scoped-dir placeholder;
    // the token is never written into a file.
    expect(r!.files['settings.json']).toContain('__FLOCK_CONFIG_DIR__/flock-hook.sh');
    expect(r!.files['flock-hook.sh']).toContain('$FLOCK_HOOK_TOKEN');
    expect(JSON.stringify(r)).not.toContain('Bearer ey'); // no plaintext token
  });

  it('codex: NO scoped config (uses real ~/.codex so auth persists + transcript is tailed)', async () => {
    // Codex hooks.toml is inert in current codex, and a scoped CODEX_HOME broke
    // auth persistence + transcript discovery — so codex is deliberately un-scoped.
    expect(await renderHookConfig('codex')).toBeNull();
  });

  it('opencode: plugin file under native .config/opencode/plugin', async () => {
    const r = await renderHookConfig('opencode');
    expect(r!.configBaseSubdir).toBe('.config');
    expect(Object.keys(r!.files)).toContain(`opencode/plugin/${OPENCODE_PLUGIN_FILENAME}`);
    expect(r!.files[`opencode/plugin/${OPENCODE_PLUGIN_FILENAME}`]).toContain('FlockPlugin');
  });

  it('grok: hooks/flock.json + forwarder in native .grok config', async () => {
    const r = await renderHookConfig('grok');
    expect(r!.configBaseSubdir).toBe('.grok');
    expect(Object.keys(r!.files)).toContain('hooks/flock.json');
    expect(Object.keys(r!.files)).toContain('flock-hook.sh');
    const hooks = JSON.parse(r!.files['hooks/flock.json']!) as { hooks: Record<string, unknown> };
    // Lifecycle events registered (PascalCase grok names); Notification is skipped (meta noise).
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'Stop',
      ]),
    );
    expect(Object.keys(hooks.hooks)).not.toContain('Notification');
    expect(r!.files['hooks/flock.json']).toContain('flock-hook.sh');
  });

  it('agents with no first-class hook config return null', async () => {
    expect(await renderHookConfig('terminal')).toBeNull();
    expect(await renderHookConfig('dev')).toBeNull();
  });
});
