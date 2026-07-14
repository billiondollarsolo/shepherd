import { describe, expect, it } from 'vitest';
import {
  DeploymentPreviewSettingsResponse,
  ListProjectPortsResponse,
  SaveProjectPortRequest,
  StartProjectForwardResponse,
} from './previews.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const forwardId = '44444444-4444-4444-8444-444444444444';
const now = '2026-07-14T00:00:00.000Z';

describe('project Ports contracts', () => {
  it('accepts a strict composite saved/detected/active response', () => {
    const parsed = ListProjectPortsResponse.parse({
      ports: [
        {
          id: serviceId,
          serviceId,
          projectId,
          nodeId,
          targetHost: '127.0.0.1',
          targetPort: 5173,
          protocol: 'http',
          label: 'Web',
          source: 'saved',
          process: { pid: 42, name: 'vite' },
          remembered: true,
          autoForward: true,
          status: 'forwarding',
          lastSeenAt: now,
          forward: {
            id: forwardId,
            backend: 'hostname',
            origin: 'https://p-random.preview.example.com',
            createdAt: now,
            expiresAt: '2026-07-14T02:00:00.000Z',
            health: 'ready',
            embedding: 'allowed',
            embeddingReason: null,
          },
        },
      ],
      discovery: {
        supported: true,
        healthy: true,
        reason: null,
        observedAt: now,
        unassignedCount: 0,
        ambiguousCount: 0,
      },
    });
    expect(parsed.ports[0]?.forward?.origin).toContain('preview.example.com');
  });

  it('rejects unknown fields, privileged ports, and capability leakage', () => {
    expect(() => SaveProjectPortRequest.parse({ targetPort: 80 })).toThrow();
    expect(() => SaveProjectPortRequest.parse({ targetPort: 3000, url: 'http://evil' })).toThrow();
    expect(() =>
      StartProjectForwardResponse.parse({
        port: {},
        launchUrl: 'https://preview.example.com/#token=secret',
        token: 'must-not-be-a-field',
      }),
    ).toThrow();
  });

  it('keeps infrastructure read-only and runtime preferences bounded', () => {
    const base = {
      deployment: {
        backend: 'port_pool',
        deploymentMode: 'private-http',
        enabled: true,
        reason: null,
        publicUrl: 'http://100.64.0.1:11010',
        previewDomain: null,
        portRange: { start: 12000, end: 12001, capacity: 2 },
        gatewayHealthy: true,
        activeForwards: 0,
        allocatedSlots: 0,
        hardLimits: {
          ttlMs: 28_800_000,
          maxConcurrent: 16,
          maxConnectionsPerForward: 32,
          maxRequestBytes: 1024,
          maxResponseBytes: 1024,
        },
        restartRequiredFields: ['portRange'],
        privateModeWarning: 'Private mode',
        embeddingEnabled: true,
        embeddingReason: null,
        frameSources: ['http://100.64.0.1:12000', 'http://100.64.0.1:12001'],
      },
      runtime: { enabled: true, defaultTtlMs: 7_200_000, autoForwardPolicy: 'off' },
    };
    expect(DeploymentPreviewSettingsResponse.parse(base).deployment.portRange?.capacity).toBe(2);
    expect(() =>
      DeploymentPreviewSettingsResponse.parse({
        ...base,
        runtime: { ...base.runtime, defaultTtlMs: 1 },
      }),
    ).toThrow();
  });
});
