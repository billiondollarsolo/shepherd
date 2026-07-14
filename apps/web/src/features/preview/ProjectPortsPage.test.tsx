import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectPort, ProjectForward } from '@flock/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../components/ui';
import { usePaddock } from '../../store/paddock';

const projectId = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const now = '2026-07-14T12:00:00.000Z';
const expiresAt = '2026-07-14T20:00:00.000Z';

let mockProjects: Array<Record<string, unknown>> = [];
let mockNodes: Array<Record<string, unknown>> = [];
let mockPortsQuery: Record<string, unknown>;

const mockActivate = { mutate: vi.fn(), isPending: false };
const mockRefresh = { mutate: vi.fn(), isPending: false };
const mockSave = { mutateAsync: vi.fn(), isPending: false };
const mockUpdate = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const mockForget = { mutateAsync: vi.fn(), isPending: false };
const mockStart = { mutateAsync: vi.fn(), isPending: false };
const mockRelaunch = { mutateAsync: vi.fn(), isPending: false };
const mockStop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock('../../data/queries', () => ({
  useProjects: () => ({ data: mockProjects }),
  useNodes: () => ({ data: mockNodes }),
  useProjectPorts: () => mockPortsQuery,
  useDeploymentPreviewSettings: () => ({
    data: {
      deployment: { embeddingEnabled: true, embeddingReason: null },
    },
  }),
  useActivateProjectPorts: () => mockActivate,
  useRefreshProjectPorts: () => mockRefresh,
  useSaveProjectPort: () => mockSave,
  useUpdateProjectPort: () => mockUpdate,
  useForgetProjectPort: () => mockForget,
  useStartProjectForward: () => mockStart,
  useRelaunchProjectForward: () => mockRelaunch,
  useStopProjectForward: () => mockStop,
}));

import { ProjectPortsPage } from './ProjectPortsPage';

const forward: ProjectForward = {
  id: '44444444-4444-4444-8444-444444444444',
  backend: 'hostname',
  origin: 'https://web.preview.example.com',
  createdAt: now,
  expiresAt,
  health: 'ready',
  embedding: 'allowed',
  embeddingReason: null,
};

function port(input: Partial<ProjectPort> = {}): ProjectPort {
  return {
    id: input.serviceId ?? `detected:${input.targetPort ?? 3000}`,
    serviceId: null,
    projectId,
    nodeId,
    targetHost: '127.0.0.1',
    targetPort: 3000,
    protocol: 'http',
    label: 'Web',
    source: 'detected',
    process: { pid: 42, name: 'vite' },
    remembered: false,
    autoForward: false,
    status: 'detected',
    lastSeenAt: now,
    forward: null,
    ...input,
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <ProjectPortsPage />
    </TooltipProvider>,
  );
}

describe('ProjectPortsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjects = [{ id: projectId, nodeId, name: 'Shepherd' }];
    mockNodes = [{ id: nodeId, name: 'workstation' }];
    mockPortsQuery = {
      data: {
        ports: [],
        discovery: {
          supported: true,
          healthy: true,
          reason: null,
          observedAt: now,
          unassignedCount: 0,
          ambiguousCount: 0,
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    usePaddock.setState({ selectedProjectId: projectId });
    mockSave.mutateAsync.mockImplementation(
      async (input: { targetPort: number; label: string }) => ({
        port: port({
          serviceId,
          targetPort: input.targetPort,
          label: input.label,
          remembered: true,
        }),
      }),
    );
    mockStart.mutateAsync.mockResolvedValue({
      port: port({ serviceId, remembered: true, status: 'forwarding', forward }),
      launchUrl: 'https://web.preview.example.com/?token=one-time',
    });
    mockRelaunch.mutateAsync.mockResolvedValue({
      port: port({ serviceId, remembered: true, status: 'forwarding', forward }),
      launchUrl: 'https://web.preview.example.com/?token=relaunched',
    });
    mockUpdate.mutateAsync.mockResolvedValue({});
    mockForget.mutateAsync.mockResolvedValue({});
    mockStop.mutateAsync.mockResolvedValue({});
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  });

  it('requires a selected, available project', () => {
    usePaddock.setState({ selectedProjectId: null });
    renderPage();
    expect(screen.getByText('Select a project to inspect its ports.')).toBeInTheDocument();
    expect(mockActivate.mutate).not.toHaveBeenCalled();
  });

  it('activates discovery and validates a manually forwarded port', async () => {
    renderPage();
    expect(screen.getByText('No web services detected')).toBeInTheDocument();
    expect(mockActivate.mutate).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /forward a port/i }));
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a port from 1024 to 65535.');

    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '3100' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockSave.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ targetPort: 3100, label: 'Docs' }),
      );
    });
  });

  it('renders discovery state and saved-service controls', async () => {
    mockPortsQuery = {
      ...mockPortsQuery,
      data: {
        ports: [
          port({ serviceId, remembered: true, autoForward: true, status: 'stopped' }),
          port({
            id: 'unreachable',
            serviceId: '55555555-5555-4555-8555-555555555555',
            label: 'API',
            targetPort: 4000,
            status: 'unreachable',
          }),
          port({
            id: 'expired',
            serviceId: '66666666-6666-4666-8666-666666666666',
            label: 'Storybook',
            targetPort: 6006,
            status: 'expired',
          }),
          port({
            id: 'forwarding',
            serviceId: '77777777-7777-4777-8777-777777777777',
            label: 'Preview',
            status: 'forwarding',
            forward: { ...forward, backend: 'port_pool' },
          }),
        ],
        discovery: {
          supported: true,
          healthy: false,
          reason: 'Listener inspection is degraded.',
          observedAt: now,
          unassignedCount: 2,
          ambiguousCount: 1,
        },
      },
    };
    renderPage();

    expect(screen.getByText('Listener inspection is degraded.')).toBeInTheDocument();
    expect(screen.getByText(/2 node listeners could not be assigned/)).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Forwarding')).toBeInTheDocument();
    expect(screen.getByText('Private port pool')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mockRefresh.mutate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(mockUpdate.mutate).toHaveBeenCalledWith({
      serviceId,
      input: { autoForward: false },
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Rename service' })[0]);
    const rename = screen.getByDisplayValue('Web');
    fireEvent.change(rename, { target: { value: 'Dashboard' } });
    fireEvent.submit(rename.closest('form')!);
    await waitFor(() =>
      expect(mockUpdate.mutateAsync).toHaveBeenCalledWith({
        serviceId,
        input: { label: 'Dashboard' },
      }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Forget service' })[0]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Forget Web?');
    fireEvent.click(screen.getByRole('button', { name: 'Forget service' }));
    await waitFor(() => expect(mockForget.mutateAsync).toHaveBeenCalledWith(serviceId));
  });

  it('saves a detected listener and opens an embedded Preview', async () => {
    mockPortsQuery = {
      ...mockPortsQuery,
      data: {
        ...(mockPortsQuery.data as Record<string, unknown>),
        ports: [port()],
      },
    };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }));

    expect(await screen.findByTestId('embedded-preview')).toBeInTheDocument();
    expect(mockSave.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ targetPort: 3000, autoForward: false }),
    );
    expect(mockStart.mutateAsync).toHaveBeenCalledWith({ serviceId });
    expect(screen.getByTitle('Web Preview')).toHaveAttribute(
      'src',
      'https://web.preview.example.com/?token=one-time',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy Preview URL' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(forward.origin);
    fireEvent.click(screen.getByRole('button', { name: 'Back to project ports' }));
    expect(screen.getByTestId('project-ports-page')).toBeInTheDocument();
  });

  it('offers a direct link when the browser blocks a Preview popup', async () => {
    mockPortsQuery = {
      ...mockPortsQuery,
      data: {
        ...(mockPortsQuery.data as Record<string, unknown>),
        ports: [port({ serviceId, remembered: true, status: 'forwarding', forward })],
      },
    };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(await screen.findByText(/browser blocked the new tab/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Preview' })).toHaveAttribute(
      'href',
      'https://web.preview.example.com/?token=relaunched',
    );
  });
});
