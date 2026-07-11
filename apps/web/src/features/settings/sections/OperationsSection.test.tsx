import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OperationsSection } from './OperationsSection';

vi.mock('../diagnosticsApi', () => ({
  fetchDiagnostics: async () => ({
    bundleVersion: 1,
    generatedAt: '2026-07-11T00:00:00.000Z',
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
    diagnostics: {
      generatedAt: '2026-07-11T00:00:00.000Z',
      counters: {},
      events: [],
    },
    privacy: { included: 'metadata', excluded: 'secrets and PTY content' },
  }),
}));

describe('OperationsSection', () => {
  it('shows actionable dependency health and the protected bundle action', async () => {
    render(<OperationsSection />);
    expect(await screen.findByText('Flock 0.3.0')).toBeInTheDocument();
    expect(screen.getByText('Browser runtime')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download bundle/i })).toHaveAttribute(
      'href',
      '/api/diagnostics/bundle',
    );
  });
});
