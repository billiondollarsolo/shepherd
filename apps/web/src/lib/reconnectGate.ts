export interface ReconnectEnvironment {
  online(): boolean;
  visible(): boolean;
  addOnline(listener: () => void): void;
  removeOnline(listener: () => void): void;
  addVisibility(listener: () => void): void;
  removeVisibility(listener: () => void): void;
  setTimer(listener: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const browserEnvironment: ReconnectEnvironment = {
  online: () => typeof navigator === 'undefined' || navigator.onLine,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  addOnline: (listener) => window.addEventListener('online', listener),
  removeOnline: (listener) => window.removeEventListener('online', listener),
  addVisibility: (listener) => document.addEventListener('visibilitychange', listener),
  removeVisibility: (listener) => document.removeEventListener('visibilitychange', listener),
  setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * Defer a reconnect until the browser is online and visible, then apply the
 * caller's jittered delay. Returns idempotent cleanup for React teardown.
 */
export function deferReconnect(
  reconnect: () => void,
  delayMs: number,
  environment: ReconnectEnvironment = browserEnvironment,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearListeners = (): void => {
    environment.removeOnline(arm);
    environment.removeVisibility(arm);
  };
  const arm = (): void => {
    if (cancelled) return;
    clearListeners();
    if (!environment.online()) {
      environment.addOnline(arm);
      return;
    }
    if (!environment.visible()) {
      environment.addVisibility(arm);
      return;
    }
    timer = environment.setTimer(() => {
      timer = undefined;
      if (!cancelled) reconnect();
    }, delayMs);
  };
  arm();
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearListeners();
    if (timer !== undefined) environment.clearTimer(timer);
  };
}
