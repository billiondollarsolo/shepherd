import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_TOOL_CATALOG, type NodeCapabilitiesResponse } from '@flock/shared';

import { TooltipProvider } from '../../components/ui';

const install = vi.fn();
const configureDocker = vi.fn();
let response: NodeCapabilitiesResponse;
let latestVersion: { latest: string | null; checkedAt: string } | undefined;

vi.mock('../../data/queries', () => ({
  useNodeCapabilities: () => ({ data: response, isLoading: false }),
  useInstallNodeTool: () => ({ isPending: false, mutateAsync: install }),
  useConfigureNodeDocker: () => ({ isPending: false, mutateAsync: configureDocker }),
  useLatestVersion: () => ({ data: latestVersion }),
}));

const BUNDLED_REASON =
  'The bundled local runtime is immutable; update Shepherd to change its bundled tools.';

/** Rewrite the fixture so every tool reports the immutable bundled-runtime reason. */
function bundledRuntime(): NodeCapabilitiesResponse {
  const base = capabilities();
  return {
    ...base,
    tools: base.tools.map((tool) => ({
      ...tool,
      installSupported: false,
      installReason: BUNDLED_REASON,
    })),
  };
}

import { NodeCapabilitiesPanel } from './NodeCapabilitiesPanel';

function capabilities(): NodeCapabilitiesResponse {
  return {
    nodeId: '11111111-1111-4111-8111-111111111111',
    generatedAt: '2026-07-15T00:00:00.000Z',
    tools: NODE_TOOL_CATALOG.map((tool, index) => ({
      id: tool.id,
      agentType: tool.agentType,
      label: tool.label,
      binary: tool.binary,
      integration: tool.integration,
      installed: index === 0,
      path: index === 0 ? '/home/flock-agent/.local/bin/claude' : null,
      version: index === 0 ? '2.1.210' : null,
      installSupported: true,
      installReason: null,
    })),
    docker: {
      installed: true,
      version: 'Docker version 29.1.3',
      daemonRunning: true,
      agentAccess: false,
      accessMode: 'none',
      installSupported: true,
      accessManagementSupported: true,
      reason: null,
    },
  };
}

function renderPanel(): void {
  render(
    <TooltipProvider>
      <NodeCapabilitiesPanel nodeId="11111111-1111-4111-8111-111111111111" />
    </TooltipProvider>,
  );
}

describe('NodeCapabilitiesPanel', () => {
  beforeEach(() => {
    response = capabilities();
    latestVersion = { latest: null, checkedAt: '' };
    install.mockReset();
    configureDocker.mockReset();
  });

  it('shows every launchable coding tool and its integration depth', () => {
    renderPanel();

    for (const tool of NODE_TOOL_CATALOG) {
      expect(screen.getByTestId(`node-tool-${tool.id}`)).toHaveTextContent(tool.label);
    }
    expect(screen.getAllByText('First-class')).toHaveLength(5);
    expect(screen.getAllByText('Terminal integration')).toHaveLength(3);
  });

  it('requires confirmation before installing a missing tool', () => {
    renderPanel();

    const card = screen.getByTestId('node-tool-amp');
    fireEvent.click(card.querySelector('button')!);

    expect(screen.getByRole('dialog')).toHaveTextContent('Install Amp?');
    expect(install).not.toHaveBeenCalled();
  });

  it('makes Docker root-equivalent access explicit before enabling it', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Enable for agents' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Docker daemon access is root-equivalent');
    expect(configureDocker).not.toHaveBeenCalled();
  });

  it('shows the bundled-runtime version + update command instead of a dead-end warning', () => {
    response = bundledRuntime();
    latestVersion = { latest: null, checkedAt: '' };
    renderPanel();

    const card = screen.getByTestId('bundled-runtime-card');
    expect(card).toHaveTextContent('Bundled runtime');
    expect(card).toHaveTextContent('docker compose pull && docker compose up -d');
    // No live "update available" claim when the latest version is unknown.
    expect(card).not.toHaveTextContent('Update available');
    expect(card).not.toHaveTextContent('Up to date');
    // The old cryptic banner is gone.
    expect(screen.queryByText(/Managed installs are unavailable/)).toBeNull();
  });

  it('flags an available update when a newer release exists', () => {
    response = bundledRuntime();
    latestVersion = { latest: '999.0.0', checkedAt: '' };
    renderPanel();

    expect(screen.getByTestId('bundled-runtime-card')).toHaveTextContent(
      'Update available · v999.0.0',
    );
  });

  it('disables managed actions when node preparation is too old', () => {
    response = {
      ...capabilities(),
      tools: capabilities().tools.map((tool) => ({
        ...tool,
        installSupported: false,
        installReason: 'Update node preparation.',
      })),
    };
    renderPanel();

    expect(screen.getByText(/Managed installs are unavailable/)).toHaveTextContent(
      'Update node preparation.',
    );
    expect(screen.getByTestId('node-tool-amp').querySelector('button')).toBeDisabled();
  });
});
