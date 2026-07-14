import type { DeploymentMode, DeploymentStatus } from '@flock/shared';

/** WebSocket Origin and browser-transport policy parsed once at process startup. */
export interface OriginPolicy {
  /** Canonical origins accepted from browser WebSocket upgrades. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Canonical public URL used for callbacks and browser-facing links. */
  readonly publicBaseUrl?: string;
  readonly mode: 'production' | 'development';
  readonly deployment: DeploymentStatus;
}

const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;
const PRODUCTION_DEPLOYMENT_MODES = new Set<DeploymentMode>([
  'builtin-tls',
  'external-tls',
  'private-http',
]);
const PRIVATE_HTTP_WARNING =
  'Private HTTP mode — traffic is not encrypted. Use only on a trusted LAN or VPN.';

/** Resolve only the named mode; full URL/origin validation happens at startup below. */
export function deploymentMode(env: Readonly<Record<string, string | undefined>>): DeploymentMode {
  if (env.NODE_ENV !== 'production') return 'development';
  const configured = env.FLOCK_DEPLOYMENT_MODE?.trim() || 'builtin-tls';
  if (!PRODUCTION_DEPLOYMENT_MODES.has(configured as DeploymentMode)) {
    throw new Error(
      'FLOCK_DEPLOYMENT_MODE must be builtin-tls, external-tls, or private-http in production',
    );
  }
  return configured as DeploymentMode;
}

export function allowsInsecureHttp(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.FLOCK_ALLOW_INSECURE_HTTP === '1';
}

/**
 * Parse an exact HTTP(S) origin. Paths, credentials, query strings, fragments,
 * wildcards, and non-web schemes are rejected so configuration cannot look
 * narrower than the authority it actually grants.
 */
export function parseExactOrigin(raw: string, name: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} contains an invalid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must use http:// or https://`);
  }
  if (
    value.includes('*') ||
    value !== parsed.origin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`${name} must contain exact origins only (scheme, host, and optional port)`);
  }
  return parsed.origin;
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((entry, index) => {
    if (entry.trim() === '') {
      throw new Error(`FLOCK_ALLOWED_ORIGINS contains an empty entry at position ${index + 1}`);
    }
    return parseExactOrigin(entry, `FLOCK_ALLOWED_ORIGINS entry ${index + 1}`);
  });
}

/**
 * Resolve startup configuration. Production requires both a public URL and an
 * explicit allowlist containing that URL. Development has narrow localhost
 * defaults and may add a Tailnet/LAN origin explicitly.
 */
export function readOriginPolicy(env: Readonly<Record<string, string | undefined>>): OriginPolicy {
  const production = env.NODE_ENV === 'production';
  const selectedDeployment = deploymentMode(env);
  const privateHttp = selectedDeployment === 'private-http';
  const insecureAcknowledged = allowsInsecureHttp(env);
  const publicBaseUrl = env.PUBLIC_BASE_URL
    ? parseExactOrigin(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL')
    : undefined;
  const configured = parseAllowedOrigins(env.FLOCK_ALLOWED_ORIGINS);

  if (production && !publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required when NODE_ENV=production');
  }
  if (production && privateHttp && !insecureAcknowledged) {
    throw new Error(
      'private-http requires FLOCK_ALLOW_INSECURE_HTTP=1 as an explicit acknowledgement',
    );
  }
  if (production && !privateHttp && insecureAcknowledged) {
    throw new Error(
      'FLOCK_ALLOW_INSECURE_HTTP=1 is valid only with FLOCK_DEPLOYMENT_MODE=private-http',
    );
  }
  if (production && publicBaseUrl) {
    const expectedProtocol = privateHttp ? 'http://' : 'https://';
    if (!publicBaseUrl.startsWith(expectedProtocol)) {
      throw new Error(
        `PUBLIC_BASE_URL must use ${expectedProtocol} with FLOCK_DEPLOYMENT_MODE=${selectedDeployment}`,
      );
    }
  }
  if (production && configured.length === 0) {
    throw new Error('FLOCK_ALLOWED_ORIGINS is required when NODE_ENV=production');
  }
  if (
    production &&
    configured.some((origin) => !origin.startsWith(privateHttp ? 'http://' : 'https://'))
  ) {
    throw new Error(
      `every FLOCK_ALLOWED_ORIGINS entry must use ${privateHttp ? 'http://' : 'https://'} with FLOCK_DEPLOYMENT_MODE=${selectedDeployment}`,
    );
  }
  if (production && publicBaseUrl && !configured.includes(publicBaseUrl)) {
    throw new Error('FLOCK_ALLOWED_ORIGINS must include PUBLIC_BASE_URL in production');
  }
  const origins = production ? configured : [...DEVELOPMENT_ORIGINS, ...configured];
  if (!production && publicBaseUrl) origins.push(publicBaseUrl);

  return {
    allowedOrigins: new Set(origins),
    publicBaseUrl,
    mode: production ? 'production' : 'development',
    deployment: {
      mode: selectedDeployment,
      transport: privateHttp || publicBaseUrl?.startsWith('http://') ? 'http' : 'https',
      warning: privateHttp ? PRIVATE_HTTP_WARNING : null,
    },
  };
}

/** Safe one-line startup summary; contains origins but never credentials/tokens. */
export function describeOriginPolicy(policy: OriginPolicy): string {
  return `[security] mode=${policy.mode} deployment=${policy.deployment.mode} transport=${policy.deployment.transport} websocket-origins=${[...policy.allowedOrigins].join(',')}`;
}
