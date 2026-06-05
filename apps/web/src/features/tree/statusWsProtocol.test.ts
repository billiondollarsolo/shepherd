import { describe, it, expect } from 'vitest';
import {
  STATUS_CHANNEL,
  statusWebSocketUrl,
  encodeStatusSubscribe,
  parseStatusFrame,
} from './statusWsProtocol';

describe('statusWsProtocol (US-23)', () => {
  it('uses the spec §8.2 `status` channel name', () => {
    expect(STATUS_CHANNEL).toBe('status');
  });

  it('derives a wss:// URL from an https origin (same-origin deploy)', () => {
    expect(statusWebSocketUrl({}, 'https://flock.example')).toBe(
      'wss://flock.example/ws/status',
    );
  });

  it('derives a ws:// URL from an http origin', () => {
    expect(statusWebSocketUrl({}, 'http://localhost:5173')).toBe(
      'ws://localhost:5173/ws/status',
    );
  });

  it('prefers an explicit VITE_WS_URL base when configured', () => {
    expect(statusWebSocketUrl({ VITE_WS_URL: 'wss://api.flock.example/' }, 'http://x')).toBe(
      'wss://api.flock.example/ws/status',
    );
  });

  it('encodes a channel subscribe envelope with no sessionId', () => {
    expect(JSON.parse(encodeStatusSubscribe())).toEqual({
      op: 'subscribe',
      channel: 'status',
    });
  });

  it('parses a valid status frame (object form)', () => {
    const ts = '2026-05-29T06:30:00.000Z';
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const msg = parseStatusFrame({
      channel: 'status',
      sessionId,
      status: 'awaiting_input',
      detail: 'permission prompt',
      ts,
    });
    expect(msg).toEqual({
      channel: 'status',
      sessionId,
      status: 'awaiting_input',
      detail: 'permission prompt',
      ts,
    });
  });

  it('parses a valid status frame (JSON string form)', () => {
    const sessionId = '22222222-2222-2222-2222-222222222222';
    const json = JSON.stringify({
      channel: 'status',
      sessionId,
      status: 'running',
      detail: null,
      ts: '2026-05-29T06:31:00.000Z',
    });
    const msg = parseStatusFrame(json);
    expect(msg?.status).toBe('running');
    expect(msg?.sessionId).toBe(sessionId);
  });

  it('returns null for a non-status frame (e.g. a node control frame)', () => {
    expect(
      parseStatusFrame({
        channel: 'nodes',
        nodeId: '33333333-3333-3333-3333-333333333333',
        connectionStatus: 'connected',
        lastSeenAt: null,
        ts: '2026-05-29T06:32:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null for malformed JSON / garbage', () => {
    expect(parseStatusFrame('not json')).toBeNull();
    expect(parseStatusFrame(42)).toBeNull();
    expect(parseStatusFrame({ channel: 'status' })).toBeNull(); // missing fields
  });
});
