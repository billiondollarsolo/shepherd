import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type {
  DeploymentPreviewSettingsResponse,
  PreviewRoutingTestResponse,
  PreviewRuntimeSettings,
  ProjectForward,
} from '@flock/shared';
import { and, eq } from 'drizzle-orm';
import type { AuditLogger } from '../audit/audit.js';
import type { Database } from '../db/client.js';
import { nodes, previewRuntimeSettings, projectServices, projects } from '../db/schema.js';
import type { NodeTransport } from '../nodes/transport/transport.js';
import { hasNodeTcpDialer } from '../nodes/transport/tcp-dialer.js';
import {
  poolPreviewOrigin,
  previewOrigin,
  type PreviewBackend,
  type PreviewConfig,
} from './config.js';

interface PreviewRecord {
  id: string;
  serviceId: string;
  projectId: string;
  nodeId: string;
  targetHost: '127.0.0.1' | '::1';
  port: number;
  protocol: 'http' | 'https';
  backend: Exclude<PreviewBackend, 'disabled'>;
  hostname: string;
  publicPort?: number;
  origin: string;
  createdAt: string;
  expiresAt: string;
  tokenHash: Buffer;
  launchAvailable: boolean;
  cookieName: string;
  embedding: 'unknown' | 'allowed' | 'blocked';
  embeddingReason: string | null;
}

export interface PreviewServiceDeps {
  db: Database;
  audit: AuditLogger;
  config: PreviewConfig;
  transportForNode(nodeId: string): Promise<NodeTransport | null> | NodeTransport | null;
  now?: () => number;
  randomToken?: () => string;
  randomSlug?: () => string;
  randomSlotOffset?: (capacity: number) => number;
}

export class PreviewDisabledError extends Error {}
export class PreviewServiceNotFoundError extends Error {}
export class PreviewForbiddenError extends Error {}
export class PreviewUnavailableError extends Error {}
export class PreviewLimitError extends Error {}

const DEFAULT_RUNTIME_SETTINGS: PreviewRuntimeSettings = {
  enabled: true,
  defaultTtlMs: 2 * 60 * 60_000,
  autoForwardPolicy: 'off',
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function equalSecret(candidate: string, expected: Buffer): boolean {
  const actual = digest(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PreviewService {
  private readonly config: PreviewConfig;
  private readonly byService = new Map<string, PreviewRecord>();
  private readonly byHostname = new Map<string, PreviewRecord>();
  private readonly byPublicPort = new Map<number, PreviewRecord>();
  private readonly inactiveStatuses = new Map<string, 'expired' | 'unreachable'>();
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly randomSlug: () => string;
  private readonly randomSlotOffset: (capacity: number) => number;
  private readonly inactiveListeners = new Set<(recordId: string) => void>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly serviceOperations = new Map<string, Promise<void>>();
  private readonly pendingLaunches = new Map<
    string,
    Promise<{ forward: ProjectForward; launchUrl: string }>
  >();
  private pendingAllocations = 0;
  private lifecycleEpoch = 0;
  private disposed = false;
  private gatewayHealthy = false;
  private routingTester: (() => Promise<PreviewRoutingTestResponse['checks']>) | null = null;

  constructor(private readonly deps: PreviewServiceDeps) {
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.randomToken = deps.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.randomSlug = deps.randomSlug ?? (() => randomBytes(10).toString('hex'));
    this.randomSlotOffset = deps.randomSlotOffset ?? ((capacity) => randomInt(capacity));
  }

  async start(
    serviceId: string,
    requestedTtlMs: number | undefined,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ forward: ProjectForward; launchUrl: string }> {
    const pending = this.pendingLaunches.get(serviceId);
    if (pending) return pending;
    const operation = this.withServiceOperation(serviceId, () =>
      this.startUnlocked(serviceId, requestedTtlMs, actor),
    );
    this.pendingLaunches.set(serviceId, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingLaunches.get(serviceId) === operation) {
        this.pendingLaunches.delete(serviceId);
      }
    }
  }

  private async startUnlocked(
    serviceId: string,
    requestedTtlMs: number | undefined,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ forward: ProjectForward; launchUrl: string }> {
    if (this.disposed) throw new PreviewUnavailableError('The Preview gateway is shutting down.');
    const lifecycleEpoch = this.lifecycleEpoch;
    this.reapExpired();
    const runtime = await this.runtimeSettings(actor.userId);
    if (!this.config.enabled || this.config.backend === 'disabled' || !runtime.enabled) {
      throw new PreviewDisabledError(
        !runtime.enabled
          ? 'Preview is disabled by the runtime kill switch.'
          : (this.config.reason ?? 'Remote Preview is disabled.'),
      );
    }
    const service = await this.requireOwnedService(serviceId, actor.userId);
    const existing = this.byService.get(serviceId);
    let allocationReserved = false;
    if (!existing) {
      if (this.byService.size + this.pendingAllocations >= this.config.maxConcurrent) {
        throw new PreviewLimitError('The Preview concurrency limit has been reached.');
      }
      this.pendingAllocations += 1;
      allocationReserved = true;
    }
    const releaseAllocation = () => {
      if (!allocationReserved) return;
      this.pendingAllocations -= 1;
      allocationReserved = false;
    };

    let transport: NodeTransport | null;
    try {
      transport = await this.deps.transportForNode(service.nodeId);
      if (!transport || !hasNodeTcpDialer(transport)) {
        throw new PreviewUnavailableError('The project node cannot open Preview tunnels.');
      }
      await this.probe(transport.dialTcp(service.port, service.targetHost));
    } catch (error) {
      this.setInactiveStatus(serviceId, 'unreachable');
      releaseAllocation();
      throw error;
    }
    try {
      const [confirmedService, confirmedRuntime] = await Promise.all([
        this.requireOwnedService(serviceId, actor.userId),
        this.runtimeSettings(actor.userId),
      ]);
      if (
        this.disposed ||
        this.lifecycleEpoch !== lifecycleEpoch ||
        !confirmedRuntime.enabled ||
        confirmedService.projectId !== service.projectId ||
        confirmedService.nodeId !== service.nodeId ||
        confirmedService.targetHost !== service.targetHost ||
        confirmedService.port !== service.port ||
        confirmedService.protocol !== service.protocol
      ) {
        throw new PreviewUnavailableError(
          'The project or Preview policy changed while the forward was starting. Retry from Ports.',
        );
      }
    } catch (error) {
      releaseAllocation();
      throw error;
    }
    releaseAllocation();
    this.inactiveStatuses.delete(serviceId);
    const ttlMs = Math.min(requestedTtlMs ?? runtime.defaultTtlMs, this.config.ttlMs);
    if (existing) {
      const token = this.rotateCapability(existing, ttlMs);
      await this.deps.audit.record({
        action: 'preview_forward_start',
        userId: actor.userId,
        targetType: 'project',
        targetId: service.projectId,
        ip: actor.ip ?? null,
        detail: {
          event: 'replace',
          serviceId,
          backend: existing.backend,
          expiresAt: existing.expiresAt,
        },
      });
      return {
        forward: this.publicRecord(existing),
        launchUrl: `${existing.origin}/_shepherd/authorize#token=${encodeURIComponent(token)}`,
      };
    }

    const token = this.randomToken();
    const allocation = this.allocate();
    const now = this.now();
    const id = randomUUID();
    const cookieSuffix = randomBytes(12).toString('hex');
    const record: PreviewRecord = {
      id,
      serviceId,
      projectId: service.projectId,
      nodeId: service.nodeId,
      targetHost: service.targetHost,
      port: service.port,
      protocol: service.protocol as 'http' | 'https',
      backend: allocation.backend,
      hostname: allocation.hostname,
      publicPort: allocation.publicPort,
      origin: allocation.origin,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      tokenHash: digest(token),
      launchAvailable: true,
      cookieName: `${this.config.secureCookies ? '__Host-shepherd_preview_' : 'shepherd_preview_'}${cookieSuffix}`,
      embedding: 'unknown',
      embeddingReason: null,
    };
    this.byService.set(serviceId, record);
    if (record.backend === 'hostname') this.byHostname.set(record.hostname, record);
    else this.byPublicPort.set(record.publicPort!, record);
    this.scheduleExpiry(record);
    try {
      await this.deps.audit.record({
        action: 'preview_forward_start',
        userId: actor.userId,
        targetType: 'project',
        targetId: service.projectId,
        ip: actor.ip ?? null,
        detail: {
          serviceId,
          targetPort: service.port,
          backend: record.backend,
          publicPort: record.publicPort,
          hostname: record.backend === 'hostname' ? record.hostname : undefined,
          expiresAt: record.expiresAt,
        },
      });
    } catch (error) {
      this.deleteRecord(record);
      throw error;
    }
    if (this.byService.get(serviceId) !== record) {
      throw new PreviewUnavailableError('The Preview expired before it was ready.');
    }
    return {
      forward: this.publicRecord(record),
      launchUrl: `${record.origin}/_shepherd/authorize#token=${encodeURIComponent(token)}`,
    };
  }

  async revoke(
    serviceId: string,
    actor: { userId: string; ip?: string | null },
    reason = 'user',
  ): Promise<boolean> {
    return this.withServiceOperation(serviceId, () =>
      this.revokeUnlocked(serviceId, actor, reason),
    );
  }

  private async revokeUnlocked(
    serviceId: string,
    actor: { userId: string; ip?: string | null },
    reason: string,
  ): Promise<boolean> {
    const service = await this.requireOwnedService(serviceId, actor.userId);
    const record = this.byService.get(serviceId);
    if (!record) return false;
    this.deleteRecord(record);
    await this.deps.audit.record({
      action: 'preview_forward_stop',
      userId: actor.userId || null,
      targetType: 'project',
      targetId: service.projectId,
      ip: actor.ip ?? null,
      detail: { serviceId, targetPort: record.port, backend: record.backend, reason },
    });
    return true;
  }

  async relaunch(
    serviceId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ forward: ProjectForward; launchUrl: string }> {
    const pending = this.pendingLaunches.get(serviceId);
    if (pending) return pending;
    const operation = this.withServiceOperation(serviceId, () =>
      this.relaunchUnlocked(serviceId, actor),
    );
    this.pendingLaunches.set(serviceId, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingLaunches.get(serviceId) === operation) {
        this.pendingLaunches.delete(serviceId);
      }
    }
  }

  private async relaunchUnlocked(
    serviceId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ forward: ProjectForward; launchUrl: string }> {
    const service = await this.requireOwnedService(serviceId, actor.userId);
    const record = this.byService.get(serviceId);
    if (!record || !this.isActive(record)) {
      throw new PreviewUnavailableError('Start forwarding this Port before relaunching it.');
    }
    const token = this.rotateCapability(record);
    await this.deps.audit.record({
      action: 'preview_forward_start',
      userId: actor.userId,
      targetType: 'project',
      targetId: service.projectId,
      ip: actor.ip ?? null,
      detail: { event: 'relaunch', serviceId, backend: record.backend },
    });
    return {
      forward: this.publicRecord(record),
      launchUrl: `${record.origin}/_shepherd/authorize#token=${encodeURIComponent(token)}`,
    };
  }

  activeForService(serviceId: string): ProjectForward | null {
    this.reapExpired();
    const record = this.byService.get(serviceId);
    return record ? this.publicRecord(record) : null;
  }

  inactiveStatus(serviceId: string): 'expired' | 'unreachable' | null {
    this.reapExpired();
    return this.inactiveStatuses.get(serviceId) ?? null;
  }

  recordForHostname(hostname: string): PreviewRecord | null {
    this.reapExpired();
    return this.byHostname.get(hostname.toLowerCase()) ?? null;
  }

  recordForPublicPort(port: number): PreviewRecord | null {
    this.reapExpired();
    return this.byPublicPort.get(port) ?? null;
  }

  authorize(record: PreviewRecord, token: string): PreviewRecord | null {
    if (
      !this.isActive(record) ||
      !record.launchAvailable ||
      !equalSecret(token, record.tokenHash)
    ) {
      return null;
    }
    record.launchAvailable = false;
    return record;
  }

  authenticate(record: PreviewRecord, cookieToken: string): PreviewRecord | null {
    return this.isActive(record) && equalSecret(cookieToken, record.tokenHash) ? record : null;
  }

  isActiveHostname(hostname: string): boolean {
    return this.recordForHostname(hostname) !== null;
  }

  async dial(record: PreviewRecord): Promise<Duplex> {
    if (!this.isActive(record)) {
      throw new PreviewUnavailableError('The Preview is no longer active.');
    }
    const transport = await this.deps.transportForNode(record.nodeId);
    if (!transport || !hasNodeTcpDialer(transport)) {
      throw new PreviewUnavailableError('The project node is unavailable.');
    }
    const stream = await this.withConnectTimeout(transport.dialTcp(record.port, record.targetHost));
    if (!this.isActive(record)) {
      stream.destroy();
      throw new PreviewUnavailableError('The Preview is no longer active.');
    }
    return stream;
  }

  cookieName(record: PreviewRecord): string {
    return record.cookieName;
  }

  cookieMaxAge(record: PreviewRecord): number {
    return Math.max(1, Math.floor((Date.parse(record.expiresAt) - this.now()) / 1000));
  }

  limits(): Pick<
    PreviewConfig,
    | 'maxConnectionsPerPreview'
    | 'maxRequestBytes'
    | 'maxResponseBytes'
    | 'connectTimeoutMs'
    | 'upstreamTimeoutMs'
  > {
    return this.config;
  }

  onInactive(listener: (recordId: string) => void): () => void {
    this.inactiveListeners.add(listener);
    return () => this.inactiveListeners.delete(listener);
  }

  setGatewayHealthy(healthy: boolean): void {
    this.gatewayHealthy = healthy;
  }

  setRoutingTester(tester: (() => Promise<PreviewRoutingTestResponse['checks']>) | null): void {
    this.routingTester = tester;
  }

  noteEmbeddingHeaders(record: PreviewRecord, headers: NodeJS.Dict<string | string[]>): void {
    if (!this.isActive(record)) return;
    const xFrameOptions = firstHeader(headers['x-frame-options']);
    const contentSecurityPolicy = firstHeader(headers['content-security-policy']);
    if (xFrameOptions && /(?:^|,)\s*(?:deny|sameorigin)\s*(?:,|$)/i.test(xFrameOptions)) {
      record.embedding = 'blocked';
      record.embeddingReason = `The app returned X-Frame-Options: ${xFrameOptions.slice(0, 160)}.`;
      return;
    }
    if (
      contentSecurityPolicy &&
      /(?:^|;)\s*frame-ancestors\s+(?:'none'|'self')(?:\s*;|\s*$)/i.test(contentSecurityPolicy)
    ) {
      record.embedding = 'blocked';
      record.embeddingReason =
        'The app Content-Security-Policy does not allow Shepherd to embed it.';
      return;
    }
    record.embedding = 'allowed';
    record.embeddingReason = null;
  }

  async routingTest(actor: {
    userId: string;
    ip?: string | null;
  }): Promise<PreviewRoutingTestResponse> {
    const checks: PreviewRoutingTestResponse['checks'] = [
      {
        id: 'configuration',
        status: this.config.enabled ? 'pass' : 'fail',
        detail: this.config.enabled
          ? `The ${this.config.backend === 'port_pool' ? 'private port-pool' : 'hostname'} backend is configured.`
          : (this.config.reason ?? 'Preview is disabled.'),
      },
    ];
    if (this.routingTester) checks.push(...(await this.routingTester()));
    else {
      checks.push({
        id: 'gateway',
        status: this.gatewayHealthy ? 'pass' : 'fail',
        detail: this.gatewayHealthy
          ? 'The Preview gateway reports healthy.'
          : 'The Preview gateway is not accepting connections.',
      });
    }
    const response = {
      ok: checks.every((check) => check.status !== 'fail'),
      checkedAt: new Date(this.now()).toISOString(),
      checks,
    } satisfies PreviewRoutingTestResponse;
    await this.deps.audit.record({
      action: 'preview_test',
      userId: actor.userId,
      targetType: 'installation',
      targetId: 'preview',
      ip: actor.ip ?? null,
      detail: { ok: response.ok, checks: checks.map(({ id, status }) => ({ id, status })) },
    });
    return response;
  }

  size(): number {
    this.reapExpired();
    return this.byService.size;
  }

  allocatedSlots(): number {
    this.reapExpired();
    return this.byPublicPort.size;
  }

  async runtimeSettings(userId: string): Promise<PreviewRuntimeSettings> {
    const [row] = await this.deps.db
      .select()
      .from(previewRuntimeSettings)
      .where(eq(previewRuntimeSettings.userId, userId))
      .limit(1);
    return row
      ? {
          enabled: row.enabled,
          defaultTtlMs: Math.min(row.defaultTtlMs, this.config.ttlMs),
          autoForwardPolicy: row.autoForwardPolicy as PreviewRuntimeSettings['autoForwardPolicy'],
        }
      : {
          ...DEFAULT_RUNTIME_SETTINGS,
          defaultTtlMs: Math.min(DEFAULT_RUNTIME_SETTINGS.defaultTtlMs, this.config.ttlMs),
        };
  }

  async updateRuntimeSettings(
    userId: string,
    patch: Partial<PreviewRuntimeSettings>,
    ip?: string | null,
  ): Promise<PreviewRuntimeSettings> {
    const current = await this.runtimeSettings(userId);
    const next: PreviewRuntimeSettings = {
      enabled: patch.enabled ?? current.enabled,
      defaultTtlMs: Math.min(patch.defaultTtlMs ?? current.defaultTtlMs, this.config.ttlMs),
      autoForwardPolicy: patch.autoForwardPolicy ?? current.autoForwardPolicy,
    };
    await this.deps.db
      .insert(previewRuntimeSettings)
      .values({ userId, ...next, updatedAt: new Date(this.now()) })
      .onConflictDoUpdate({
        target: previewRuntimeSettings.userId,
        set: { ...next, updatedAt: new Date(this.now()) },
      });
    if (!next.enabled) {
      this.lifecycleEpoch += 1;
      for (const record of [...this.byService.values()]) {
        this.deleteRecord(record, 'runtime_disabled');
      }
    }
    await this.deps.audit.record({
      action: 'preview_settings_update',
      userId,
      targetType: 'installation',
      targetId: 'preview',
      ip: ip ?? null,
      detail: {
        enabled: next.enabled,
        defaultTtlMs: next.defaultTtlMs,
        autoForwardPolicy: next.autoForwardPolicy,
      },
    });
    return next;
  }

  async deploymentSettings(userId: string): Promise<DeploymentPreviewSettingsResponse> {
    return {
      deployment: {
        backend: this.config.backend,
        deploymentMode: this.config.deploymentMode,
        enabled: this.config.enabled,
        reason: this.config.reason,
        publicUrl: this.config.publicBaseUrl,
        previewDomain: this.config.domain,
        portRange: this.config.portRange,
        gatewayHealthy: this.gatewayHealthy,
        activeForwards: this.size(),
        allocatedSlots: this.allocatedSlots(),
        hardLimits: {
          ttlMs: this.config.ttlMs,
          maxConcurrent: this.config.maxConcurrent,
          maxConnectionsPerForward: this.config.maxConnectionsPerPreview,
          maxRequestBytes: this.config.maxRequestBytes,
          maxResponseBytes: this.config.maxResponseBytes,
        },
        restartRequiredFields: [
          'backend',
          'publicUrl',
          'previewDomain',
          'portRange',
          'bindAddress',
          'TLS and proxy configuration',
        ],
        privateModeWarning: this.config.privateModeWarning,
        embeddingEnabled: this.config.embeddingEnabled,
        embeddingReason: this.config.embeddingReason,
        frameSources: [...this.config.frameSources],
      },
      runtime: await this.runtimeSettings(userId),
    };
  }

  revokeForProject(projectId: string): void {
    this.lifecycleEpoch += 1;
    for (const record of [...this.byService.values()]) {
      if (record.projectId === projectId) this.deleteRecord(record, 'project_removed');
    }
  }

  revokeForNode(nodeId: string): void {
    this.lifecycleEpoch += 1;
    for (const record of [...this.byService.values()]) {
      if (record.nodeId === nodeId) this.deleteRecord(record, 'node_removed');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    for (const record of [...this.byService.values()]) this.deleteRecord(record);
    this.inactiveListeners.clear();
    this.gatewayHealthy = false;
  }

  private allocate(): {
    backend: 'hostname' | 'port_pool';
    hostname: string;
    publicPort?: number;
    origin: string;
  } {
    if (this.config.backend === 'hostname' && this.config.domain) {
      const hostname = this.uniqueHostname(this.config.domain);
      return { backend: 'hostname', hostname, origin: previewOrigin(this.config, hostname) };
    }
    if (this.config.backend === 'port_pool' && this.config.portRange && this.config.publicHost) {
      const { start, capacity } = this.config.portRange;
      const offset = this.randomSlotOffset(capacity);
      for (let index = 0; index < capacity; index += 1) {
        const publicPort = start + ((offset + index) % capacity);
        if (!this.byPublicPort.has(publicPort)) {
          return {
            backend: 'port_pool',
            hostname: this.config.publicHost,
            publicPort,
            origin: poolPreviewOrigin(this.config, publicPort),
          };
        }
      }
      throw new PreviewLimitError('The private Preview port pool is exhausted.');
    }
    throw new PreviewDisabledError(this.config.reason ?? 'Preview routing is unavailable.');
  }

  private async requireOwnedService(serviceId: string, userId: string) {
    const [service] = await this.deps.db
      .select({
        id: projectServices.id,
        projectId: projectServices.projectId,
        nodeId: projects.nodeId,
        owner: nodes.createdBy,
        targetHost: projectServices.targetHost,
        port: projectServices.targetPort,
        protocol: projectServices.protocol,
      })
      .from(projectServices)
      .innerJoin(projects, eq(projects.id, projectServices.projectId))
      .innerJoin(nodes, eq(nodes.id, projects.nodeId))
      .where(and(eq(projectServices.id, serviceId), eq(projects.nodeId, nodes.id)))
      .limit(1);
    if (!service) throw new PreviewServiceNotFoundError('Project service not found.');
    if (service.owner && service.owner !== userId) {
      throw new PreviewForbiddenError('Project service access denied.');
    }
    return { ...service, targetHost: service.targetHost as '127.0.0.1' | '::1' };
  }

  private async probe(pending: Promise<Duplex>): Promise<void> {
    let stream: Duplex;
    try {
      stream = await this.withConnectTimeout(pending);
    } catch (error) {
      throw new PreviewUnavailableError(
        `Nothing accepted a connection on that node port: ${(error as Error).message}`,
      );
    }
    stream.destroy();
  }

  private async withConnectTimeout(pending: Promise<Duplex>): Promise<Duplex> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Preview connection timed out')),
            this.config.connectTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      void pending.then((late) => late.destroy()).catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private reapExpired(): void {
    const now = this.now();
    for (const record of this.byService.values()) {
      if (Date.parse(record.expiresAt) <= now) this.deleteRecord(record, 'expired');
    }
  }

  private scheduleExpiry(record: PreviewRecord): void {
    const delay = Math.max(1, Date.parse(record.expiresAt) - this.now());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(record.id);
      if (this.byService.get(record.serviceId) === record) this.deleteRecord(record, 'expired');
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(record.id, timer);
  }

  private rotateCapability(record: PreviewRecord, ttlMs?: number): string {
    const token = this.randomToken();
    record.tokenHash = digest(token);
    record.launchAvailable = true;
    record.cookieName = `${this.config.secureCookies ? '__Host-shepherd_preview_' : 'shepherd_preview_'}${randomBytes(12).toString('hex')}`;
    if (ttlMs !== undefined) {
      const currentTimer = this.expiryTimers.get(record.id);
      if (currentTimer) clearTimeout(currentTimer);
      this.expiryTimers.delete(record.id);
      record.expiresAt = new Date(this.now() + ttlMs).toISOString();
      this.scheduleExpiry(record);
    }
    for (const listener of this.inactiveListeners) listener(record.id);
    return token;
  }

  private isActive(record: PreviewRecord): boolean {
    return this.byService.get(record.serviceId) === record;
  }

  private deleteRecord(record: PreviewRecord, systemReason?: string): void {
    const timer = this.expiryTimers.get(record.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(record.id);
    }
    if (!this.isActive(record)) return;
    if (systemReason === 'expired') this.setInactiveStatus(record.serviceId, 'expired');
    else this.inactiveStatuses.delete(record.serviceId);
    this.byService.delete(record.serviceId);
    if (record.backend === 'hostname' && this.byHostname.get(record.hostname) === record) {
      this.byHostname.delete(record.hostname);
    }
    if (
      record.backend === 'port_pool' &&
      record.publicPort !== undefined &&
      this.byPublicPort.get(record.publicPort) === record
    ) {
      this.byPublicPort.delete(record.publicPort);
    }
    for (const listener of this.inactiveListeners) listener(record.id);
    if (systemReason) {
      void this.deps.audit
        .record({
          action: systemReason === 'expired' ? 'preview_forward_expire' : 'preview_forward_stop',
          userId: null,
          targetType: 'project',
          targetId: record.projectId,
          ip: null,
          detail: {
            serviceId: record.serviceId,
            targetPort: record.port,
            backend: record.backend,
            reason: systemReason,
          },
        })
        .catch(() => undefined);
    }
  }

  private uniqueHostname(domain: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hostname = `p-${this.randomSlug()}.${domain}`.toLowerCase();
      if (!this.byHostname.has(hostname)) return hostname;
    }
    throw new PreviewUnavailableError('Could not allocate a unique Preview hostname.');
  }

  private setInactiveStatus(serviceId: string, status: 'expired' | 'unreachable'): void {
    this.inactiveStatuses.delete(serviceId);
    this.inactiveStatuses.set(serviceId, status);
    while (this.inactiveStatuses.size > 1_024) {
      const oldest = this.inactiveStatuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.inactiveStatuses.delete(oldest);
    }
  }

  private async withServiceOperation<T>(
    serviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serviceOperations.get(serviceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.serviceOperations.set(serviceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.serviceOperations.get(serviceId) === tail) {
        this.serviceOperations.delete(serviceId);
      }
    }
  }

  private publicRecord(record: PreviewRecord): ProjectForward {
    return {
      id: record.id,
      backend: record.backend,
      origin: record.origin,
      publicPort: record.publicPort,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      health: 'ready',
      embedding: record.embedding,
      embeddingReason: record.embeddingReason,
    };
  }
}

export type ActivePreview = PreviewRecord;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
