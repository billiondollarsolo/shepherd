/**
 * Minimal ambient types for `chrome-remote-interface` (it ships no .d.ts).
 * Declares only the surface `browser/cdp-page-client.ts` uses.
 */
declare module 'chrome-remote-interface' {
  interface CDPTarget {
    id: string;
    type: string;
    webSocketDebuggerUrl?: string;
  }

  interface CDPClient {
    Page: {
      enable(): Promise<unknown>;
      startScreencast(params: unknown): Promise<unknown>;
      stopScreencast(): Promise<unknown>;
      screencastFrameAck(params: unknown): Promise<unknown>;
      navigate(params: { url: string }): Promise<unknown>;
      reload(params?: unknown): Promise<unknown>;
      getNavigationHistory(): Promise<{
        currentIndex: number;
        entries: Array<{ url: string }>;
      }>;
    };
    Input: {
      dispatchMouseEvent(params: unknown): Promise<unknown>;
      dispatchKeyEvent(params: unknown): Promise<unknown>;
    };
    Emulation: {
      setDeviceMetricsOverride(params: unknown): Promise<unknown>;
    };
    // CRI clients are EventEmitters; we use these for screencast frame events.
    on(event: string, listener: (param: never) => void): void;
    off(event: string, listener: (param: never) => void): void;
    close(): Promise<void>;
  }

  interface CDPConnectOptions {
    host?: string;
    port?: number;
    target?: string;
  }

  interface CDPListOptions {
    host?: string;
    port?: number;
  }

  function CDP(options?: CDPConnectOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options?: CDPListOptions): Promise<CDPTarget[]>;
    function New(options?: CDPListOptions): Promise<CDPTarget>;
  }

  export default CDP;
}
