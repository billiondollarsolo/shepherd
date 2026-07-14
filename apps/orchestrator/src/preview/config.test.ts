import { describe, expect, it } from 'vitest';
import {
  parsePreviewPortRange,
  poolPreviewOrigin,
  previewOrigin,
  readPreviewConfig,
} from './config.js';

describe('readPreviewConfig', () => {
  it('derives an isolated hostname from a production DNS name', () => {
    const config = readPreviewConfig(
      { NODE_ENV: 'production', FLOCK_PREVIEW_DOMAIN: 'preview.shepherd.example.com' },
      'https://shepherd.example.com',
    );
    expect(config).toMatchObject({
      enabled: true,
      backend: 'hostname',
      domain: 'preview.shepherd.example.com',
      scheme: 'https',
      secureCookies: true,
      embeddingEnabled: true,
    });
    expect(previewOrigin(config, 'abc.preview.shepherd.example.com')).toBe(
      'https://abc.preview.shepherd.example.com',
    );
  });

  it('requires an explicit preview domain for an IP-based deployment', () => {
    const config = readPreviewConfig({ NODE_ENV: 'production' }, 'https://100.64.0.1');
    expect(config.enabled).toBe(false);
    expect(config.reason).toMatch(/FLOCK_PREVIEW_DOMAIN/);
  });

  it('does not accept the localhost preview suffix for a public control plane', () => {
    const config = readPreviewConfig(
      { NODE_ENV: 'production', FLOCK_PREVIEW_DOMAIN: 'preview.localhost' },
      'https://shepherd.example.com',
    );
    expect(config.enabled).toBe(false);
    expect(config.reason).toMatch(/public preview DNS suffix/);
  });

  it('refuses plaintext production preview transport', () => {
    const config = readPreviewConfig(
      { NODE_ENV: 'production', FLOCK_PREVIEW_DOMAIN: 'preview.example.com' },
      'http://example.com',
    );
    expect(config.enabled).toBe(false);
    expect(config.reason).toMatch(/private-http/);
  });

  it('allows HTTP preview only with a dedicated DNS suffix and explicit private mode', () => {
    const config = readPreviewConfig(
      {
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'private-http',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
        FLOCK_PREVIEW_DOMAIN: 'preview.shepherd.home.arpa',
      },
      'http://shepherd.home.arpa:11010',
    );
    expect(config).toMatchObject({
      enabled: true,
      domain: 'preview.shepherd.home.arpa',
      scheme: 'http',
      secureCookies: false,
      publicPort: '11010',
    });
  });

  it('keeps preview disabled for an IP-only private HTTP deployment', () => {
    const config = readPreviewConfig(
      {
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'private-http',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
      },
      'http://100.64.0.1:11010',
    );
    expect(config.enabled).toBe(false);
    expect(config.reason).toMatch(/FLOCK_PREVIEW_DOMAIN/);
  });

  it('supports a bounded no-DNS private port pool', () => {
    const config = readPreviewConfig(
      {
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'private-http',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
        FLOCK_PREVIEW_BACKEND: 'port-pool',
        FLOCK_PREVIEW_PORT_RANGE: '12000-12031',
      },
      'http://100.64.0.1:11010',
    );
    expect(config).toMatchObject({
      backend: 'port_pool',
      enabled: true,
      publicHost: '100.64.0.1',
      portRange: { start: 12000, end: 12031, capacity: 32 },
      embeddingEnabled: false,
    });
    expect(config.frameSources).toHaveLength(32);
    expect(poolPreviewOrigin(config, 12001)).toBe('http://100.64.0.1:12001');
  });

  it('enables port-pool embedding only for the complete finite CSP source set', () => {
    const config = readPreviewConfig(
      {
        NODE_ENV: 'production',
        FLOCK_DEPLOYMENT_MODE: 'private-http',
        FLOCK_ALLOW_INSECURE_HTTP: '1',
        FLOCK_PREVIEW_BACKEND: 'port-pool',
        FLOCK_PREVIEW_PORT_RANGE: '12000-12001',
        FLOCK_PREVIEW_FRAME_SOURCES: 'http://100.64.0.1:12000 http://100.64.0.1:12001',
      },
      'http://100.64.0.1:11010',
    );
    expect(config.embeddingEnabled).toBe(true);
    expect(config.embeddingReason).toBeNull();
  });

  it('rejects oversized, privileged, malformed, and overlapping pools', () => {
    expect(() => parsePreviewPortRange('100-120')).toThrow(/unprivileged/);
    expect(() => parsePreviewPortRange('12000-12100')).toThrow(/at most 64/);
    expect(() => parsePreviewPortRange('wat')).toThrow(/look like/);
    expect(
      readPreviewConfig(
        {
          NODE_ENV: 'production',
          FLOCK_DEPLOYMENT_MODE: 'private-http',
          FLOCK_ALLOW_INSECURE_HTTP: '1',
          FLOCK_PREVIEW_BACKEND: 'port-pool',
          FLOCK_PREVIEW_PORT_RANGE: '11010-11020',
        },
        'http://100.64.0.1:11010',
      ).reason,
    ).toMatch(/overlaps/);
  });

  it('refuses to share the control-plane hostname or accept invalid listener ports', () => {
    expect(
      readPreviewConfig(
        { NODE_ENV: 'production', FLOCK_PREVIEW_DOMAIN: 'shepherd.example.com' },
        'https://shepherd.example.com',
      ).reason,
    ).toMatch(/isolated/);
    expect(() =>
      readPreviewConfig(
        {
          NODE_ENV: 'production',
          FLOCK_PREVIEW_DOMAIN: 'preview.shepherd.example.com',
          FLOCK_PREVIEW_PORT: '70000',
        },
        'https://shepherd.example.com',
      ),
    ).toThrow(/65535/);
  });

  it('supports isolated localhost development on the preview listener port', () => {
    const config = readPreviewConfig(
      { NODE_ENV: 'development', FLOCK_PREVIEW_PUBLIC_PORT: '11012' },
      'http://localhost:11010',
    );
    expect(config.domain).toBe('preview.localhost');
    expect(previewOrigin(config, 'abc.preview.localhost')).toBe(
      'http://abc.preview.localhost:11012',
    );
  });
});
