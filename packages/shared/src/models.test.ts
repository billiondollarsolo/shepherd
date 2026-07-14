import { describe, expect, it } from 'vitest';
import {
  AgentdCompatibilityPolicySchema,
  AgentdCompatibilitySchema,
} from './agentd-compatibility.js';
import {
  BUILTIN_LAUNCHER_PRESETS,
  LauncherPresetSchema,
  LauncherPresetsPayloadSchema,
} from './launcher-presets.js';
import { singleSessionLayout } from './project-layout.js';
import {
  parseProjectPens,
  ProjectPensResponseSchema,
  PutProjectPensRequestSchema,
} from './project-pens.js';
import {
  DEFAULT_USER_PREFERENCES,
  GetUserPreferencesResponse,
  PutUserPreferencesRequest,
  PutUserPreferencesResponse,
} from './user-preferences.js';
import * as publicApi from './index.js';

const POLICY = {
  schemaVersion: 1,
  minimumDaemonVersion: '0.3.0',
  preferredProtocolVersion: 2,
  supportedProtocolVersions: [2],
  requiredCapabilities: ['pty', 'resize'],
  supportWindow: { minorReleases: 1, minimumDays: 90 },
} as const;

describe('shared public models', () => {
  it('loads the supported package entrypoint and exposes each model family', () => {
    expect(publicApi).toEqual(
      expect.objectContaining({
        AgentdCompatibilityPolicySchema,
        BUILTIN_LAUNCHER_PRESETS,
        parseProjectPens,
        DEFAULT_USER_PREFERENCES,
      }),
    );
  });

  it('validates agentd release policy invariants and compatibility results', () => {
    expect(AgentdCompatibilityPolicySchema.parse(POLICY)).toEqual(POLICY);
    expect(
      AgentdCompatibilityPolicySchema.safeParse({
        ...POLICY,
        preferredProtocolVersion: 3,
      }).success,
    ).toBe(false);
    expect(
      AgentdCompatibilityPolicySchema.safeParse({
        ...POLICY,
        supportedProtocolVersions: [2, 2],
      }).success,
    ).toBe(false);
    expect(
      AgentdCompatibilityPolicySchema.safeParse({
        ...POLICY,
        requiredCapabilities: ['pty', 'pty'],
      }).success,
    ).toBe(false);
    expect(
      AgentdCompatibilityPolicySchema.safeParse({ ...POLICY, minimumDaemonVersion: '0.3' }).success,
    ).toBe(false);

    expect(
      AgentdCompatibilitySchema.parse({
        state: 'compatible',
        reason: 'current',
        installedVersion: '0.4.0',
        preferredVersion: '0.4.0',
        minimumVersion: '0.3.0',
        protocolVersion: 2,
        supportedProtocolVersions: [2],
        missingCapabilities: [],
        servicePrepared: true,
        binaryReplacement: false,
        detail: 'Current and compatible.',
      }),
    ).toMatchObject({ state: 'compatible', reason: 'current' });
  });

  it('keeps every built-in launcher preset valid and rejects malformed custom presets', () => {
    expect(BUILTIN_LAUNCHER_PRESETS.map((preset) => LauncherPresetSchema.parse(preset))).toEqual(
      BUILTIN_LAUNCHER_PRESETS,
    );
    expect(
      LauncherPresetsPayloadSchema.parse({
        presets: BUILTIN_LAUNCHER_PRESETS,
        updatedAt: '2026-07-14T00:00:00.000Z',
      }).presets,
    ).toHaveLength(6);
    expect(LauncherPresetSchema.safeParse({ id: '', name: '', agentType: 'unknown' }).success).toBe(
      false,
    );
  });

  it('parses durable Pens, applies the independent-session default, and rejects invalid layouts', () => {
    const pens = {
      version: 1,
      projectId: 'project-1',
      activePenId: 'pen-1',
      pens: [
        {
          id: 'pen-1',
          name: 'Pen 1',
          layout: singleSessionLayout('project-1', 'session-1'),
        },
      ],
    } as const;

    const parsed = parseProjectPens(pens);
    expect(parsed?.independentSessionIds).toEqual([]);
    expect(ProjectPensResponseSchema.parse({ pens: parsed, revision: 2 }).revision).toBe(2);
    expect(PutProjectPensRequestSchema.parse({ baseRevision: 2, pens: parsed }).pens).toEqual(
      parsed,
    );
    expect(parseProjectPens({ ...pens, version: 2 })).toBeNull();
  });

  it('validates preference revisions and rejects malformed persisted values', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const nodeId = '33333333-3333-4333-8333-333333333333';
    const presetId = '44444444-4444-4444-8444-444444444444';
    const preferences = {
      version: 1,
      nodeOrder: [nodeId],
      sessionOrder: { [projectId]: [sessionId] },
      layoutPresets: [
        { id: presetId, name: 'Focus', projectId, gridLayout: 'columns', order: [sessionId] },
      ],
    } as const;
    const document = { preferences: { ...preferences, revision: 3, updatedAt: null } };

    expect(GetUserPreferencesResponse.parse(document)).toEqual(document);
    expect(PutUserPreferencesRequest.parse({ baseRevision: 3, preferences }).baseRevision).toBe(3);
    expect(PutUserPreferencesResponse.parse(document)).toEqual(document);
    expect(
      PutUserPreferencesRequest.safeParse({ baseRevision: -1, preferences: { version: 2 } })
        .success,
    ).toBe(false);
  });
});
