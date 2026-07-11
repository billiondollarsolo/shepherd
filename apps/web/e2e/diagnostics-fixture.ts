export function diagnosticsFixture(now: string): unknown {
  return {
    bundleVersion: 1,
    generatedAt: now,
    versions: {
      flock: '0.3.0',
      agentdExpected: '0.3.0',
      agents: {
        codex: { status: 'available', version: 'codex 1' },
        claude: { status: 'missing' },
        opencode: { status: 'available', version: 'opencode 1' },
      },
    },
    health: {
      process: { status: 'ready', uptimeSeconds: 1 },
      database: { status: 'ready' },
      migrations: { status: 'ready', count: 21 },
      agentd: {},
      nodes: { status: 'ready', count: 1 },
      disk: { status: 'ready', freeBytes: 1, totalBytes: 2 },
      browserRuntime: { status: 'available', image: 'browser', network: 'internal' },
      push: { status: 'not_configured' },
    },
    warnings: [],
    collections: {},
    diagnostics: { generatedAt: now, counters: {}, events: [] },
    privacy: { included: 'metadata', excluded: 'secrets and PTY content' },
  };
}
