import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserControlResponse, InputIntent } from '@flock/shared';
import { useBrowserControl, type BrowserControlTransport } from './useBrowserControl.js';

/**
 * US-28 — web control hook: takeover grants control + forwards input; release
 * stops forwarding; a rejected (single-controller) takeover surfaces an error.
 */

const SID = '55555555-5555-4555-8555-555555555555';
const CDP = 'ws://127.0.0.1:9222/devtools/browser/guid';

function controlResponse(
  action: BrowserControlResponse['action'],
  inControl: boolean,
): BrowserControlResponse {
  return { sessionId: SID, action, browserCdpEndpoint: CDP, inControl };
}

function makeTransport(overrides?: Partial<BrowserControlTransport>): BrowserControlTransport & {
  sendInput: ReturnType<typeof vi.fn>;
} {
  const sendInput = vi.fn();
  return {
    takeover: vi.fn(async () => controlResponse('takeover', true)),
    release: vi.fn(async () => controlResponse('release', false)),
    sendInput,
    ...overrides,
  } as BrowserControlTransport & { sendInput: ReturnType<typeof vi.fn> };
}

describe('useBrowserControl (US-28)', () => {
  it('starts not in control', () => {
    const { result } = renderHook(() => useBrowserControl(SID, makeTransport()));
    expect(result.current.inControl).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('takeover grants control', async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useBrowserControl(SID, transport));

    await act(async () => {
      await result.current.takeover();
    });

    expect(transport.takeover).toHaveBeenCalledWith(SID);
    expect(result.current.inControl).toBe(true);
  });

  it('forwards input intents only while in control', async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useBrowserControl(SID, transport));

    const intent: InputIntent = {
      kind: 'mouse',
      event: { type: 'mousePressed', x: 1, y: 2, button: 'left' },
    };

    // Before takeover: no-op.
    act(() => result.current.sendInput(intent));
    expect(transport.sendInput).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.takeover();
    });
    act(() => result.current.sendInput(intent));
    expect(transport.sendInput).toHaveBeenCalledWith(SID, intent);
  });

  it('release stops forwarding (subsequent input is a no-op)', async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useBrowserControl(SID, transport));

    await act(async () => {
      await result.current.takeover();
    });
    await act(async () => {
      await result.current.release();
    });

    expect(transport.release).toHaveBeenCalledWith(SID);
    expect(result.current.inControl).toBe(false);

    transport.sendInput.mockClear();
    act(() =>
      result.current.sendInput({
        kind: 'key',
        event: { type: 'keyDown', key: 'a' },
      }),
    );
    expect(transport.sendInput).not.toHaveBeenCalled();
  });

  it('a rejected takeover (single-controller) surfaces an error and stays not-in-control', async () => {
    const transport = makeTransport({
      takeover: vi.fn(async () => {
        throw new Error('session is already controlled by someone else');
      }),
    });
    const { result } = renderHook(() => useBrowserControl(SID, transport));

    await act(async () => {
      await result.current.takeover();
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.inControl).toBe(false);
    expect(result.current.error).toMatch(/already controlled/i);
  });
});
