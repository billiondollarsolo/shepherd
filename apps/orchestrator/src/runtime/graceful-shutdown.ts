import process from 'node:process';

export interface ShutdownDependencies {
  stopBackground(): void;
  closeHttp(): Promise<void>;
  disposeLiveChannels(): Promise<void>;
  disposeBrowserChannels(): Promise<void>;
  disposeConnections(): Promise<void>;
  closeDatabase(): Promise<void>;
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
}

/** Create an idempotent, ordered and hard-bounded graceful shutdown operation. */
export function createGracefulShutdown(
  dependencies: ShutdownDependencies,
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  const log = dependencies.log ?? ((message) => console.log(message));
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[flock-orchestrator] ${signal} received — shutting down`);
    const hardExit = setTimeout(() => {
      log('[flock-orchestrator] shutdown timed out — forcing exit');
      exit(1);
    }, dependencies.timeoutMs ?? 10_000);
    hardExit.unref();
    try {
      dependencies.stopBackground();
      await dependencies.closeHttp();
      await dependencies.disposeLiveChannels().catch(() => undefined);
      await dependencies.disposeBrowserChannels().catch(() => undefined);
      await dependencies.disposeConnections().catch(() => undefined);
      await dependencies.closeDatabase().catch(() => undefined);
      clearTimeout(hardExit);
      log('[flock-orchestrator] shutdown complete');
      exit(0);
    } catch (error) {
      clearTimeout(hardExit);
      log('[flock-orchestrator] error during shutdown', error);
      exit(1);
    }
  };
}

export function installShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
