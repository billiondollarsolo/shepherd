import { allowsInsecureHttp, deploymentMode } from '../auth/origin-policy.js';

export type PreviewBackend = 'hostname' | 'port_pool' | 'disabled';

export interface PreviewPortRange {
  readonly start: number;
  readonly end: number;
  readonly capacity: number;
}

export interface PreviewConfig {
  readonly backend: PreviewBackend;
  readonly deploymentMode: ReturnType<typeof deploymentMode>;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly publicBaseUrl: string | null;
  readonly publicHost: string | null;
  readonly domain: string | null;
  readonly portRange: PreviewPortRange | null;
  readonly scheme: 'http' | 'https';
  readonly publicPort: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly poolListenHost: string;
  readonly ttlMs: number;
  readonly maxConcurrent: number;
  readonly maxConnectionsPerPreview: number;
  readonly connectTimeoutMs: number;
  readonly upstreamTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly secureCookies: boolean;
  readonly privateModeWarning: string | null;
  readonly embeddingEnabled: boolean;
  readonly embeddingReason: string | null;
  readonly frameSources: readonly string[];
}

const MAX_POOL_SLOTS = 64;

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function tcpPort(raw: string | undefined, fallback: number, name: string): number {
  const port = positiveInteger(raw, fallback, name);
  if (port > 65_535) throw new Error(`${name} must be at most 65535`);
  return port;
}

function publicPort(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  return String(tcpPort(value, 443, 'FLOCK_PREVIEW_PUBLIC_PORT'));
}

function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  );
}

function urlHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname;
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

export function parsePreviewPortRange(raw: string | undefined): PreviewPortRange | null {
  if (!raw?.trim()) return null;
  const match = raw.trim().match(/^(\d{1,5})-(\d{1,5})$/);
  if (!match) throw new Error('FLOCK_PREVIEW_PORT_RANGE must look like 12000-12031');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1024 || end > 65_535 || end < start) {
    throw new Error('FLOCK_PREVIEW_PORT_RANGE must be an ordered unprivileged TCP port range');
  }
  const capacity = end - start + 1;
  if (capacity > MAX_POOL_SLOTS) {
    throw new Error(`FLOCK_PREVIEW_PORT_RANGE may contain at most ${MAX_POOL_SLOTS} ports`);
  }
  return { start, end, capacity };
}

function selectedBackend(
  env: Readonly<Record<string, string | undefined>>,
  domain: string | null,
  range: PreviewPortRange | null,
): PreviewBackend {
  const raw = env.FLOCK_PREVIEW_BACKEND?.trim().toLowerCase();
  if (raw) {
    if (raw === 'hostname' || raw === 'port-pool' || raw === 'port_pool') {
      return raw === 'hostname' ? 'hostname' : 'port_pool';
    }
    if (raw === 'disabled') return 'disabled';
    throw new Error('FLOCK_PREVIEW_BACKEND must be hostname, port-pool, or disabled');
  }
  if (range && !domain) return 'port_pool';
  return 'hostname';
}

/** Resolve both forwarding backends once at startup and fail closed on ambiguity. */
export function readPreviewConfig(
  env: Readonly<Record<string, string | undefined>>,
  publicBaseUrl?: string,
): PreviewConfig {
  const production = env.NODE_ENV === 'production';
  const selectedDeployment = deploymentMode(env);
  const privateHttp = selectedDeployment === 'private-http' && allowsInsecureHttp(env);
  const parsedPublic = publicBaseUrl ? new URL(publicBaseUrl) : null;
  const scheme = (parsedPublic?.protocol === 'https:' ? 'https' : 'http') as 'http' | 'https';
  const explicitDomain = env.FLOCK_PREVIEW_DOMAIN?.trim().toLowerCase();
  const mainHostname = parsedPublic?.hostname.toLowerCase() ?? null;

  let domain: string | null = explicitDomain || null;
  if (!domain && mainHostname === 'localhost') domain = 'preview.localhost';
  const portRange = parsePreviewPortRange(env.FLOCK_PREVIEW_PORT_RANGE);
  const backend = selectedBackend(env, domain, portRange);
  const configuredFrameSources = (env.FLOCK_PREVIEW_FRAME_SOURCES ?? '')
    .split(/\s+/)
    .map((source) => source.trim())
    .filter(Boolean);
  const configuredPort = env.FLOCK_PREVIEW_PUBLIC_PORT?.trim();
  const inheritedPort = parsedPublic?.port ?? '';
  const resolvedPublicPort = publicPort(configuredPort ?? inheritedPort);
  const listenPort = tcpPort(env.FLOCK_PREVIEW_PORT, 8081, 'FLOCK_PREVIEW_PORT');

  let reason: string | null = null;
  if (backend === 'disabled') reason = 'Remote Preview is disabled by deployment configuration.';
  else if (!parsedPublic) reason = 'PUBLIC_BASE_URL is required to create browser Preview links.';
  else if (backend === 'hostname') {
    if (!domain) reason = 'Set FLOCK_PREVIEW_DOMAIN to a dedicated preview DNS suffix.';
    else if (!validHostname(domain)) reason = 'FLOCK_PREVIEW_DOMAIN must be a plain DNS hostname.';
    else if (domain.endsWith('.localhost') && mainHostname !== 'localhost')
      reason = 'A public Shepherd origin requires a public preview DNS suffix.';
    else if (domain === mainHostname)
      reason = 'FLOCK_PREVIEW_DOMAIN must be isolated from the Shepherd control-plane hostname.';
    else if (production && scheme !== 'https' && !privateHttp)
      reason =
        'Remote Preview over HTTP is available only in explicitly acknowledged private-http mode.';
  } else {
    domain = null;
    if (!portRange) reason = 'Set FLOCK_PREVIEW_PORT_RANGE for private no-DNS Preview.';
    else if (!privateHttp && production)
      reason = 'Port-pool Preview is initially supported only in acknowledged private-http mode.';
    else if (scheme !== 'http')
      reason = 'Port-pool Preview currently requires a private HTTP public URL.';
    else {
      const publicControlPort = Number(parsedPublic.port || 80);
      if (
        (publicControlPort >= portRange.start && publicControlPort <= portRange.end) ||
        (listenPort >= portRange.start && listenPort <= portRange.end)
      ) {
        reason = 'FLOCK_PREVIEW_PORT_RANGE overlaps a Shepherd control or hostname gateway port.';
      }
    }
  }

  const expectedFrameSources =
    backend === 'hostname' && domain
      ? [`${scheme}://*.${domain}${resolvedPublicPort ? `:${resolvedPublicPort}` : ''}`]
      : backend === 'port_pool' && portRange && mainHostname
        ? Array.from({ length: portRange.capacity }, (_, index) => {
            return `${scheme}://${urlHostname(mainHostname)}:${portRange.start + index}`;
          })
        : [];
  const managedHostnameFrameSource =
    selectedDeployment === 'development' ||
    (selectedDeployment === 'builtin-tls' &&
      (resolvedPublicPort === '' || resolvedPublicPort === '443'));
  const embeddingEnabled =
    reason === null &&
    expectedFrameSources.length > 0 &&
    (backend === 'hostname' && managedHostnameFrameSource
      ? true
      : expectedFrameSources.every((source) => configuredFrameSources.includes(source)));
  const embeddingReason = embeddingEnabled
    ? null
    : (reason ??
      (expectedFrameSources.length === 0
        ? 'No safe Preview frame source can be derived from this deployment.'
        : 'The control-plane CSP does not declare every required Preview origin. Open in browser remains available.'));

  return {
    backend,
    deploymentMode: selectedDeployment,
    enabled: reason === null,
    reason,
    publicBaseUrl: parsedPublic?.origin ?? null,
    publicHost: mainHostname,
    domain: backend === 'hostname' && reason === null ? domain : null,
    portRange: backend === 'port_pool' && reason === null ? portRange : null,
    scheme,
    publicPort: resolvedPublicPort,
    listenHost: env.FLOCK_PREVIEW_HOST?.trim() || '127.0.0.1',
    listenPort,
    poolListenHost: env.FLOCK_PREVIEW_POOL_HOST?.trim() || '0.0.0.0',
    ttlMs: positiveInteger(env.FLOCK_PREVIEW_TTL_MS, 8 * 60 * 60_000, 'FLOCK_PREVIEW_TTL_MS'),
    maxConcurrent: positiveInteger(
      env.FLOCK_PREVIEW_MAX_CONCURRENT,
      16,
      'FLOCK_PREVIEW_MAX_CONCURRENT',
    ),
    maxConnectionsPerPreview: positiveInteger(
      env.FLOCK_PREVIEW_MAX_CONNECTIONS,
      32,
      'FLOCK_PREVIEW_MAX_CONNECTIONS',
    ),
    connectTimeoutMs: positiveInteger(
      env.FLOCK_PREVIEW_CONNECT_TIMEOUT_MS,
      3_000,
      'FLOCK_PREVIEW_CONNECT_TIMEOUT_MS',
    ),
    upstreamTimeoutMs: positiveInteger(
      env.FLOCK_PREVIEW_UPSTREAM_TIMEOUT_MS,
      120_000,
      'FLOCK_PREVIEW_UPSTREAM_TIMEOUT_MS',
    ),
    maxRequestBytes: positiveInteger(
      env.FLOCK_PREVIEW_MAX_REQUEST_BYTES,
      64 * 1024 * 1024,
      'FLOCK_PREVIEW_MAX_REQUEST_BYTES',
    ),
    maxResponseBytes: positiveInteger(
      env.FLOCK_PREVIEW_MAX_RESPONSE_BYTES,
      64 * 1024 * 1024,
      'FLOCK_PREVIEW_MAX_RESPONSE_BYTES',
    ),
    secureCookies: scheme === 'https',
    privateModeWarning:
      backend === 'port_pool'
        ? 'Private port-pool mode shares one cookie host across ports. Use only on a trusted Tailnet or LAN and prefer hostname mode for untrusted applications.'
        : privateHttp
          ? 'Preview traffic is unencrypted and must remain on a trusted private network.'
          : null,
    embeddingEnabled,
    embeddingReason,
    frameSources: expectedFrameSources,
  };
}

export function previewOrigin(config: PreviewConfig, hostname: string): string {
  const port = config.publicPort ? `:${config.publicPort}` : '';
  return `${config.scheme}://${hostname}${port}`;
}

export function poolPreviewOrigin(config: PreviewConfig, port: number): string {
  if (!config.publicHost || !config.portRange) throw new Error('Preview port pool is unavailable');
  if (port < config.portRange.start || port > config.portRange.end) {
    throw new Error('Preview port is outside the configured pool');
  }
  return `${config.scheme}://${urlHostname(config.publicHost)}:${port}`;
}
