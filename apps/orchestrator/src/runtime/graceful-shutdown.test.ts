import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown, type ShutdownDependencies } from './graceful-shutdown.js';

function fixture(overrides: Partial<ShutdownDependencies> = {}) {
  const calls: string[] = [];
  const exit = vi.fn();
  const step = (name: string) => async () => {
    calls.push(name);
  };
  const shutdown = createGracefulShutdown({
    stopBackground: () => calls.push('background'),
    closeHttp: step('http'),
    closePreviewGateway: step('preview-http'),
    disposeLiveChannels: step('live'),
    disposePreview: () => calls.push('preview'),
    disposeConnections: step('connections'),
    closeDatabase: step('database'),
    log: () => undefined,
    exit,
    ...overrides,
  });
  return { shutdown, calls, exit };
}

describe('graceful shutdown', () => {
  it('runs once in dependency order and exits successfully', async () => {
    const { shutdown, calls, exit } = fixture();
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(calls).toEqual([
      'background',
      'http',
      'preview-http',
      'live',
      'preview',
      'connections',
      'database',
    ]);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits unsuccessfully when draining HTTP fails', async () => {
    const { shutdown, exit } = fixture({
      closeHttp: async () => Promise.reject(new Error('boom')),
    });
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
