import { describe, expect, it, vi } from 'vitest';
import { deferReconnect, type ReconnectEnvironment } from './reconnectGate';

function fixture(initial: { online: boolean; visible: boolean }) {
  let online = initial.online;
  let visible = initial.visible;
  let onlineListener: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  const timers: Array<() => void> = [];
  const environment: ReconnectEnvironment = {
    online: () => online,
    visible: () => visible,
    addOnline: (listener) => (onlineListener = listener),
    removeOnline: (listener) => {
      if (onlineListener === listener) onlineListener = undefined;
    },
    addVisibility: (listener) => (visibilityListener = listener),
    removeVisibility: (listener) => {
      if (visibilityListener === listener) visibilityListener = undefined;
    },
    setTimer: (listener) => {
      timers.push(listener);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => timers.splice(0),
  };
  return {
    environment,
    goOnline: () => {
      online = true;
      onlineListener?.();
    },
    show: () => {
      visible = true;
      visibilityListener?.();
    },
    fireTimer: () => timers.shift()?.(),
  };
}

describe('deferReconnect', () => {
  it('waits for online and visible before scheduling a reconnect', () => {
    const state = fixture({ online: false, visible: false });
    const reconnect = vi.fn();
    deferReconnect(reconnect, 100, state.environment);
    state.goOnline();
    state.fireTimer();
    expect(reconnect).not.toHaveBeenCalled();
    state.show();
    state.fireTimer();
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('cancels timers and listeners during teardown', () => {
    const state = fixture({ online: true, visible: true });
    const reconnect = vi.fn();
    const cancel = deferReconnect(reconnect, 100, state.environment);
    cancel();
    state.fireTimer();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
