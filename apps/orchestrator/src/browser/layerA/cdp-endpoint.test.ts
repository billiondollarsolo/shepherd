import { describe, expect, it } from 'vitest';
import { buildCdpEndpoint, isOpaqueCdpEndpoint, newBrowserGuid } from './cdp-endpoint.js';

describe('Layer A — opaque CDP endpoint (FR-B1, NFR-SEC5)', () => {
  it('mints unguessable, unique GUIDs', () => {
    const a = newBrowserGuid();
    const b = newBrowserGuid();
    expect(a).not.toEqual(b);
    // UUID v4 shape — long and unguessable, not a sequence/port.
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('builds a full ws URL that includes the GUID, never a bare port', () => {
    const guid = '11111111-2222-3333-4444-555555555555';
    const ep = buildCdpEndpoint({ host: '127.0.0.1', port: 49251, guid });
    expect(ep.url).toBe(
      'ws://127.0.0.1:49251/devtools/browser/11111111-2222-3333-4444-555555555555',
    );
    expect(ep.url).toContain(guid);
    // Not a bare port / not a bare host:port authority.
    expect(ep.url).not.toMatch(/^\d+$/);
    expect(ep.url).toMatch(/^ws:\/\//);
  });

  it("uses chrome's own browser ws path when provided", () => {
    const ep = buildCdpEndpoint({
      host: '127.0.0.1',
      port: 5000,
      guid: 'abc',
      browserWsPath: '/devtools/browser/CHROME-GENERATED-GUID',
    });
    expect(ep.url).toBe('ws://127.0.0.1:5000/devtools/browser/CHROME-GENERATED-GUID');
  });

  describe('isOpaqueCdpEndpoint', () => {
    it('accepts a full ws URL with an opaque path', () => {
      expect(isOpaqueCdpEndpoint('ws://127.0.0.1:49251/devtools/browser/' + newBrowserGuid())).toBe(
        true,
      );
    });

    it('rejects a bare port', () => {
      expect(isOpaqueCdpEndpoint('9222')).toBe(false);
    });

    it('rejects a bare host:port authority', () => {
      expect(isOpaqueCdpEndpoint('127.0.0.1:9222')).toBe(false);
    });

    it('rejects a ws URL with no opaque path', () => {
      expect(isOpaqueCdpEndpoint('ws://127.0.0.1:9222')).toBe(false);
      expect(isOpaqueCdpEndpoint('ws://127.0.0.1:9222/')).toBe(false);
    });

    it('rejects empty / garbage', () => {
      expect(isOpaqueCdpEndpoint('')).toBe(false);
      expect(isOpaqueCdpEndpoint('not a url')).toBe(false);
    });
  });
});
