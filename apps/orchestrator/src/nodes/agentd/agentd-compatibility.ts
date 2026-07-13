import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AgentdCompatibilityPolicySchema,
  type AgentdCompatibility,
  type AgentdCompatibilityPolicy,
} from '@flock/shared';

import { AGENTD_CLIENT_PROTOCOL_VERSIONS } from './protocol.js';

export interface ResolvedAgentdCompatibilityPolicy extends AgentdCompatibilityPolicy {
  preferredDaemonVersion: string;
}

export interface AgentdCompatibilityFacts {
  installedVersion: string;
  servicePrepared: boolean;
  protocolVersion?: number | null;
  capabilities?: readonly string[] | null;
  /** Runtime facts count only after the daemon handshake has been authenticated. */
  runtimeVerified?: boolean;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

/** SemVer precedence comparison. Build metadata intentionally has no precedence. */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) < Number(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function loadAgentdCompatibilityPolicy(
  preferredDaemonVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ResolvedAgentdCompatibilityPolicy {
  const candidates = env.FLOCK_AGENTD_COMPATIBILITY_FILE
    ? [env.FLOCK_AGENTD_COMPATIBILITY_FILE]
    : [
        '../../agentd/COMPATIBILITY.json',
        '../agentd/COMPATIBILITY.json',
        './agentd/COMPATIBILITY.json',
      ].map((relative) => path.resolve(cwd, relative));
  let source: string | null = null;
  for (const candidate of candidates) {
    try {
      source = readFileSync(candidate, 'utf8');
      break;
    } catch {
      // Try the next supported source-tree/image location.
    }
  }
  if (source === null) {
    throw new Error(
      `Cannot resolve agentd compatibility metadata from cwd ${cwd}. ` +
        'Set FLOCK_AGENTD_COMPATIBILITY_FILE or ship agentd/COMPATIBILITY.json.',
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('agentd compatibility metadata is not valid JSON');
  }
  const policy = AgentdCompatibilityPolicySchema.parse(decoded);
  const unimplementedProtocols = policy.supportedProtocolVersions.filter(
    (version) => !(AGENTD_CLIENT_PROTOCOL_VERSIONS as readonly number[]).includes(version),
  );
  if (unimplementedProtocols.length > 0) {
    throw new Error(
      `agentd compatibility metadata names unimplemented client protocols: ${unimplementedProtocols.join(', ')}`,
    );
  }
  const preferred = parseSemver(preferredDaemonVersion);
  if (!preferred) throw new Error(`preferred agentd version is invalid: ${preferredDaemonVersion}`);
  const floorComparison = compareSemver(policy.minimumDaemonVersion, preferredDaemonVersion);
  if (floorComparison === null || floorComparison > 0) {
    throw new Error(
      `minimum agentd version ${policy.minimumDaemonVersion} exceeds preferred ${preferredDaemonVersion}`,
    );
  }
  return { ...policy, preferredDaemonVersion };
}

function result(
  policy: ResolvedAgentdCompatibilityPolicy,
  facts: AgentdCompatibilityFacts,
  partial: Pick<
    AgentdCompatibility,
    'state' | 'reason' | 'binaryReplacement' | 'detail' | 'missingCapabilities'
  >,
): AgentdCompatibility {
  return {
    ...partial,
    installedVersion: facts.installedVersion,
    preferredVersion: policy.preferredDaemonVersion,
    minimumVersion: policy.minimumDaemonVersion,
    protocolVersion: facts.protocolVersion ?? null,
    supportedProtocolVersions: [...policy.supportedProtocolVersions],
    servicePrepared: facts.servicePrepared,
  };
}

/** Pure compatibility decision used by bootstrap, readiness, API, and UI. */
export function evaluateAgentdCompatibility(
  policy: ResolvedAgentdCompatibilityPolicy,
  facts: AgentdCompatibilityFacts,
): AgentdCompatibility {
  const empty = { missingCapabilities: [] as string[] };
  if (!facts.installedVersion) {
    return result(policy, facts, {
      ...empty,
      state: 'required',
      reason: 'not-installed',
      binaryReplacement: true,
      detail: `flock-agentd ${policy.preferredDaemonVersion} must be installed.`,
    });
  }
  const floor = compareSemver(facts.installedVersion, policy.minimumDaemonVersion);
  const preferred = compareSemver(facts.installedVersion, policy.preferredDaemonVersion);
  if (floor === null || preferred === null) {
    return result(policy, facts, {
      ...empty,
      state: 'required',
      reason: 'invalid-version',
      binaryReplacement: true,
      detail: `Daemon version “${facts.installedVersion}” is not valid semantic version metadata.`,
    });
  }
  if (floor < 0) {
    return result(policy, facts, {
      ...empty,
      state: 'required',
      reason: 'below-minimum',
      binaryReplacement: true,
      detail: `Daemon ${facts.installedVersion} is below the supported minimum ${policy.minimumDaemonVersion}.`,
    });
  }
  if (facts.runtimeVerified) {
    if (
      facts.protocolVersion === null ||
      facts.protocolVersion === undefined ||
      !policy.supportedProtocolVersions.includes(facts.protocolVersion)
    ) {
      return result(policy, facts, {
        ...empty,
        state: 'required',
        reason: 'unsupported-protocol',
        binaryReplacement: preferred <= 0,
        detail: `Protocol v${facts.protocolVersion ?? 'unknown'} is unsupported; accepted versions: ${policy.supportedProtocolVersions.join(', ')}.`,
      });
    }
    const capabilities = new Set(facts.capabilities ?? []);
    const missingCapabilities = policy.requiredCapabilities.filter(
      (capability) => !capabilities.has(capability),
    );
    if (missingCapabilities.length > 0) {
      return result(policy, facts, {
        state: 'required',
        reason: 'missing-capabilities',
        missingCapabilities,
        binaryReplacement: preferred <= 0,
        detail: `Daemon is missing required capabilities: ${missingCapabilities.join(', ')}.`,
      });
    }
  }
  if (preferred < 0) {
    return result(policy, facts, {
      ...empty,
      state: 'recommended',
      reason: 'older-supported',
      binaryReplacement: true,
      detail: `Daemon ${facts.installedVersion} is supported; ${policy.preferredDaemonVersion} is recommended.`,
    });
  }
  if (!facts.servicePrepared) {
    return result(policy, facts, {
      ...empty,
      state: 'recommended',
      reason: 'service-migration',
      binaryReplacement: false,
      detail: 'The daemon is compatible, but its managed service needs migration.',
    });
  }
  if (!facts.runtimeVerified) {
    return result(policy, facts, {
      ...empty,
      state: 'recommended',
      reason: 'unverified-runtime',
      binaryReplacement: false,
      detail: 'Version is supported; connect to authenticate its protocol and capabilities.',
    });
  }
  return result(policy, facts, {
    ...empty,
    state: 'compatible',
    reason: preferred > 0 ? 'newer-compatible' : 'current',
    binaryReplacement: false,
    detail:
      preferred > 0
        ? `Daemon ${facts.installedVersion} is newer and compatible; Shepherd will not downgrade it.`
        : `Daemon ${facts.installedVersion} satisfies the current compatibility policy.`,
  });
}
