import { describe, it, expect } from 'vitest';
import {
  ptyChannel,
  ptyWebSocketUrl,
  encodeResize,
  encodePtyInput,
  decodePtyFrame,
} from './ptyProtocol';

describe('ptyProtocol', () => {
  describe('ptyChannel', () => {
    it('names the channel pty:<sessionId> per spec §8.2', () => {
      expect(ptyChannel('abc-123')).toBe('pty:abc-123');
    });
  });

  describe('ptyWebSocketUrl', () => {
    it('derives ws:// from an http origin and routes to /ws/pty/<id>', () => {
      const url = ptyWebSocketUrl('s1', {}, 'http://localhost:5173');
      expect(url).toBe('ws://localhost:5173/ws/pty/s1');
    });

    it('derives wss:// from an https origin (TLS deploy, NFR-SEC1)', () => {
      const url = ptyWebSocketUrl('s1', {}, 'https://flock.example');
      expect(url).toBe('wss://flock.example/ws/pty/s1');
    });

    it('prefers VITE_WS_URL over the page origin when configured', () => {
      const url = ptyWebSocketUrl('s1', { VITE_WS_URL: 'wss://api.flock.io/' }, 'http://localhost');
      expect(url).toBe('wss://api.flock.io/ws/pty/s1');
    });

    it('url-encodes the session id segment', () => {
      const url = ptyWebSocketUrl('a/b c', {}, 'http://h');
      expect(url).toBe('ws://h/ws/pty/a%2Fb%20c');
    });

    it('carries the initial size as a query so the PTY opens at the right size', () => {
      const url = ptyWebSocketUrl('s1', {}, 'http://h', { cols: 142, rows: 48 });
      expect(url).toBe('ws://h/ws/pty/s1?cols=142&rows=48');
    });

    it('omits the size query for a zero/invalid size', () => {
      expect(ptyWebSocketUrl('s1', {}, 'http://h', { cols: 0, rows: 0 })).toBe('ws://h/ws/pty/s1');
    });
  });

  describe('encodeResize', () => {
    it('emits the shared ClientPtyResizeMessage envelope the server validates', () => {
      expect(JSON.parse(encodeResize('sess-1', 120, 40))).toEqual({
        op: 'pty:resize',
        sessionId: 'sess-1',
        cols: 120,
        rows: 40,
      });
    });
  });

  describe('encodePtyInput', () => {
    it('encodes keystrokes to UTF-8 bytes', () => {
      expect(Array.from(encodePtyInput('a'))).toEqual([97]);
    });

    it('handles multi-byte input', () => {
      // "é" is U+00E9 → 0xC3 0xA9 in UTF-8.
      expect(Array.from(encodePtyInput('é'))).toEqual([0xc3, 0xa9]);
    });
  });

  describe('decodePtyFrame', () => {
    it('passes through an ArrayBuffer as bytes', () => {
      const buf = new Uint8Array([1, 2, 3]).buffer;
      expect(Array.from(decodePtyFrame(buf))).toEqual([1, 2, 3]);
    });

    it('passes through a Uint8Array view as bytes', () => {
      expect(Array.from(decodePtyFrame(new Uint8Array([9, 8, 7])))).toEqual([9, 8, 7]);
    });

    it('respects a view byteOffset/byteLength', () => {
      const view = new Uint8Array(new Uint8Array([0, 1, 2, 3, 4]).buffer, 1, 2);
      expect(Array.from(decodePtyFrame(view))).toEqual([1, 2]);
    });

    it('re-encodes a string frame to UTF-8 bytes', () => {
      expect(Array.from(decodePtyFrame('A'))).toEqual([65]);
    });

    it('round-trips input encode → frame decode', () => {
      const bytes = encodePtyInput('hi');
      // Pass the view (not .buffer): TextEncoder may return a view into a
      // larger pooled ArrayBuffer, so decodePtyFrame must honor offset/length.
      expect(Array.from(decodePtyFrame(bytes))).toEqual(Array.from(bytes));
    });
  });
});
