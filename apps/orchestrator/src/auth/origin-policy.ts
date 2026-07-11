/** WebSocket Origin policy parsed once at process startup. */
export interface OriginPolicy {
  /** Canonical origins accepted from browser WebSocket upgrades. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Canonical public URL used for callbacks and browser-facing links. */
  readonly publicBaseUrl?: string;
  readonly mode: 'production' | 'development';
}

const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

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
  const publicBaseUrl = env.PUBLIC_BASE_URL
    ? parseExactOrigin(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL')
    : undefined;
  const configured = parseAllowedOrigins(env.FLOCK_ALLOWED_ORIGINS);

  if (production && !publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required when NODE_ENV=production');
  }
  if (production && configured.length === 0) {
    throw new Error('FLOCK_ALLOWED_ORIGINS is required when NODE_ENV=production');
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
  };
}

/** Safe one-line startup summary; contains origins but never credentials/tokens. */
export function describeOriginPolicy(policy: OriginPolicy): string {
  return `[security] mode=${policy.mode} websocket-origins=${[...policy.allowedOrigins].join(',')}`;
}
