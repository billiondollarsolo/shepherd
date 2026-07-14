import { z } from 'zod';
import { IsoTimestamp, Uuid } from '../domain.js';

/** A development server port intentionally exposed through Shepherd. */
export const PreviewPort = z.number().int().min(1024).max(65535);
export type PreviewPort = z.infer<typeof PreviewPort>;

export const ProjectPortProtocol = z.enum(['http', 'https']);
export type ProjectPortProtocol = z.infer<typeof ProjectPortProtocol>;

export const ProjectPortSource = z.enum(['detected', 'terminal_hint', 'manual', 'saved']);
export type ProjectPortSource = z.infer<typeof ProjectPortSource>;

export const ProjectPortStatus = z.enum([
  'detected',
  'forwarding',
  'unreachable',
  'expired',
  'stopped',
]);
export type ProjectPortStatus = z.infer<typeof ProjectPortStatus>;

export const PreviewBackend = z.enum(['disabled', 'hostname', 'port_pool']);
export type PreviewBackend = z.infer<typeof PreviewBackend>;

export const ProjectPortProcess = z
  .object({
    pid: z.number().int().positive().optional(),
    name: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ProjectPortProcess = z.infer<typeof ProjectPortProcess>;

export const ProjectForward = z
  .object({
    id: Uuid,
    backend: z.enum(['hostname', 'port_pool']),
    origin: z.string().url(),
    publicPort: PreviewPort.optional(),
    createdAt: IsoTimestamp,
    expiresAt: IsoTimestamp,
    health: z.enum(['starting', 'ready', 'degraded']),
    embedding: z.enum(['unknown', 'allowed', 'blocked']),
    embeddingReason: z.string().max(240).nullable(),
  })
  .strict();
export type ProjectForward = z.infer<typeof ProjectForward>;

/** Browser-safe composite of a detected listener, saved service, and active forward. */
export const ProjectPort = z
  .object({
    /** Stable UI key. Unsaved detected listeners use a bounded derived key. */
    id: z.string().min(1).max(256),
    serviceId: Uuid.nullable(),
    projectId: Uuid,
    nodeId: Uuid,
    targetHost: z.enum(['127.0.0.1', '::1']),
    targetPort: PreviewPort,
    protocol: ProjectPortProtocol,
    label: z.string().min(1).max(80),
    source: ProjectPortSource,
    process: ProjectPortProcess.nullable(),
    remembered: z.boolean(),
    autoForward: z.boolean(),
    status: ProjectPortStatus,
    lastSeenAt: IsoTimestamp.nullable(),
    forward: ProjectForward.nullable(),
  })
  .strict();
export type ProjectPort = z.infer<typeof ProjectPort>;

export const ProjectPortDiscovery = z
  .object({
    supported: z.boolean(),
    healthy: z.boolean(),
    reason: z.string().nullable(),
    observedAt: IsoTimestamp.nullable(),
    unassignedCount: z.number().int().nonnegative(),
    ambiguousCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectPortDiscovery = z.infer<typeof ProjectPortDiscovery>;

export const ListProjectPortsResponse = z
  .object({ ports: z.array(ProjectPort), discovery: ProjectPortDiscovery })
  .strict();
export type ListProjectPortsResponse = z.infer<typeof ListProjectPortsResponse>;

export const SaveProjectPortRequest = z
  .object({
    targetHost: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
    targetPort: PreviewPort,
    protocol: ProjectPortProtocol.default('http'),
    label: z.string().trim().min(1).max(80).optional(),
    autoForward: z.boolean().default(false),
  })
  .strict();
export type SaveProjectPortRequest = z.infer<typeof SaveProjectPortRequest>;

export const UpdateProjectPortRequest = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    autoForward: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type UpdateProjectPortRequest = z.infer<typeof UpdateProjectPortRequest>;

export const StartProjectForwardRequest = z
  .object({ ttlMs: z.number().int().min(60_000).optional() })
  .strict();
export type StartProjectForwardRequest = z.infer<typeof StartProjectForwardRequest>;

export const ProjectPortResponse = z.object({ port: ProjectPort }).strict();
export type ProjectPortResponse = z.infer<typeof ProjectPortResponse>;

export const StartProjectForwardResponse = z
  .object({ port: ProjectPort, launchUrl: z.string().url() })
  .strict();
export type StartProjectForwardResponse = z.infer<typeof StartProjectForwardResponse>;

export const PreviewRuntimeSettings = z
  .object({
    enabled: z.boolean(),
    defaultTtlMs: z.number().int().min(60_000),
    autoForwardPolicy: z.enum(['off', 'remembered_on_access']),
  })
  .strict();
export type PreviewRuntimeSettings = z.infer<typeof PreviewRuntimeSettings>;

export const PreviewDeploymentStatus = z
  .object({
    backend: PreviewBackend,
    deploymentMode: z.enum(['development', 'builtin-tls', 'external-tls', 'private-http']),
    enabled: z.boolean(),
    reason: z.string().nullable(),
    publicUrl: z.string().url().nullable(),
    previewDomain: z.string().nullable(),
    portRange: z
      .object({ start: PreviewPort, end: PreviewPort, capacity: z.number().int().positive() })
      .strict()
      .nullable(),
    gatewayHealthy: z.boolean(),
    activeForwards: z.number().int().nonnegative(),
    allocatedSlots: z.number().int().nonnegative(),
    hardLimits: z
      .object({
        ttlMs: z.number().int().positive(),
        maxConcurrent: z.number().int().positive(),
        maxConnectionsPerForward: z.number().int().positive(),
        maxRequestBytes: z.number().int().positive(),
        maxResponseBytes: z.number().int().positive(),
      })
      .strict(),
    restartRequiredFields: z.array(z.string()),
    privateModeWarning: z.string().nullable(),
    embeddingEnabled: z.boolean(),
    embeddingReason: z.string().nullable(),
    frameSources: z.array(z.string()),
  })
  .strict();
export type PreviewDeploymentStatus = z.infer<typeof PreviewDeploymentStatus>;

export const DeploymentPreviewSettingsResponse = z
  .object({ deployment: PreviewDeploymentStatus, runtime: PreviewRuntimeSettings })
  .strict();
export type DeploymentPreviewSettingsResponse = z.infer<typeof DeploymentPreviewSettingsResponse>;

export const UpdatePreviewRuntimeSettingsRequest = PreviewRuntimeSettings.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one setting is required');
export type UpdatePreviewRuntimeSettingsRequest = z.infer<
  typeof UpdatePreviewRuntimeSettingsRequest
>;

export const PreviewRoutingTestResponse = z
  .object({
    ok: z.boolean(),
    checkedAt: IsoTimestamp,
    checks: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.enum(['pass', 'warning', 'fail']),
          detail: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type PreviewRoutingTestResponse = z.infer<typeof PreviewRoutingTestResponse>;
