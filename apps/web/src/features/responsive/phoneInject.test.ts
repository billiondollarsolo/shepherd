import { describe, expect, it, vi } from 'vitest';
import {
  isPtyAttachedControl,
  isPtyDetachedControl,
  phoneInjectPayload,
  sendPhoneInject,
  type PhoneWsLike,
} from './phoneInject';
import { decodePtyFrame } from '../terminal/ptyProtocol';

function makeFakeWs(opts?: {
  /** When to fire attached: after open (default), never, or detached */
  attach?: 'after-open' | 'never' | 'detached' | 'before-open';
  openReadyState?: number;
}): { ws: PhoneWsLike; sent: Uint8Array[]; factory: ReturnType<typeof vi.fn> } {
  const sent: Uint8Array[] = [];
  const attach = opts?.attach ?? 'after-open';
  const ws: PhoneWsLike = {
    readyState: opts?.openReadyState ?? 1,
    send: (data: string | ArrayBufferView | ArrayBuffer) => {
      if (typeof data === 'string') return;
      if (data instanceof Uint8Array) {
        sent.push(data.slice());
      } else if (data instanceof ArrayBuffer) {
        sent.push(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    },
    close: vi.fn(),
    onopen: null,
    onerror: null,
    onmessage: null,
    onclose: null,
  };

  const factory = vi.fn((_url: string) => {
    queueMicrotask(() => {
      if (attach === 'before-open') {
        ws.onmessage?.({
          data: JSON.stringify({ channel: 'pty', sessionId: 'sess-1', op: 'attached' }),
        });
      }
      ws.onopen?.(undefined);
      if (attach === 'after-open') {
        queueMicrotask(() => {
          ws.onmessage?.({
            data: JSON.stringify({ channel: 'pty', sessionId: 'sess-1', op: 'attached' }),
          });
        });
      } else if (attach === 'detached') {
        queueMicrotask(() => {
          ws.onmessage?.({
            data: JSON.stringify({ channel: 'pty', sessionId: 'sess-1', op: 'detached' }),
          });
        });
      }
      // 'never' — no attach control
    });
    return ws;
  });

  return { ws, sent, factory };
}

describe('phoneInject (real PTY path)', () => {
  it('phoneInjectPayload stages without CR and submits with CR', () => {
    const staged = phoneInjectPayload('hello', false);
    const submitted = phoneInjectPayload('hello', true);
    expect(new TextDecoder().decode(decodePtyFrame(staged))).toBe('hello');
    expect(new TextDecoder().decode(decodePtyFrame(submitted))).toBe('hello\r');
  });

  it('isPtyAttachedControl recognizes server attach ack', () => {
    expect(isPtyAttachedControl(JSON.stringify({ channel: 'pty', op: 'attached' }))).toBe(true);
    expect(isPtyAttachedControl(JSON.stringify({ channel: 'pty', op: 'resize' }))).toBe(false);
    expect(isPtyAttachedControl(new ArrayBuffer(4))).toBe(false);
  });

  it('sendPhoneInject waits for attached before send (not on open alone)', async () => {
    const sent: Uint8Array[] = [];
    let openFired = false;
    let attachAfterOpen = false;

    const factory = vi.fn((_url: string) => {
      const ws: PhoneWsLike = {
        readyState: 1,
        send: (data) => {
          // Must not send binary before attach path sets a flag
          expect(attachAfterOpen).toBe(true);
          if (data instanceof Uint8Array) sent.push(data.slice());
          else if (ArrayBuffer.isView(data)) {
            sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          }
        },
        close: vi.fn(),
        onopen: null,
        onerror: null,
        onmessage: null,
        onclose: null,
      };
      queueMicrotask(() => {
        openFired = true;
        ws.onopen?.(undefined);
        // If inject sent on open, send would have run with attachAfterOpen false.
        queueMicrotask(() => {
          attachAfterOpen = true;
          ws.onmessage?.({
            data: JSON.stringify({ channel: 'pty', sessionId: 'sess-1', op: 'attached' }),
          });
        });
      });
      return ws;
    });

    const result = await sendPhoneInject('sess-1', 'y', true, {
      wsFactory: factory,
      timeoutMs: 2000,
    });
    expect(openFired).toBe(true);
    expect(result.sessionId).toBe('sess-1');
    expect(sent.length).toBe(1);
    expect(new TextDecoder().decode(decodePtyFrame(sent[0]!))).toBe('y\r');
    expect(factory.mock.calls[0]![0]).toMatch(/sess-1/);
  });

  it('sendPhoneInject does not resolve success when attach never arrives', async () => {
    const { factory, sent } = makeFakeWs({ attach: 'never' });
    await expect(
      sendPhoneInject('sess-1', 'x', true, { wsFactory: factory, timeoutMs: 50 }),
    ).rejects.toThrow(/attach timed out|not ready/i);
    expect(sent.length).toBe(0);
  });

  it('sendPhoneInject fails when transport detaches before input', async () => {
    const { factory, sent } = makeFakeWs({ attach: 'detached' });
    await expect(
      sendPhoneInject('sess-1', 'x', true, { wsFactory: factory, timeoutMs: 2000 }),
    ).rejects.toThrow(/detached/i);
    expect(sent.length).toBe(0);
  });

  it('isPtyDetachedControl', () => {
    expect(isPtyDetachedControl(JSON.stringify({ channel: 'pty', op: 'detached' }))).toBe(true);
    expect(isPtyDetachedControl(JSON.stringify({ channel: 'pty', op: 'exited' }))).toBe(true);
  });
});
