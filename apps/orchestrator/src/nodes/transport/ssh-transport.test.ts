import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { runtimeAwareRemoteCommand } from './ssh-transport.js';

describe('runtimeAwareRemoteCommand', () => {
  it('probes the prepared-node helper before selecting the runtime identity', () => {
    const remote = runtimeAwareRemoteCommand('printf hello');

    expect(remote).toContain('runtime-exec-supported');
    expect(remote).toContain('runtime-exec');
    expect(remote).toContain(Buffer.from('printf hello').toString('base64'));
  });

  it('keeps a shell-quoted direct-user fallback for unprepared nodes', () => {
    const command = `printf '%s' "quoted payload"`;
    const remote = runtimeAwareRemoteCommand(command);

    expect(remote).toContain('else exec /bin/sh -c');
    expect(remote).toContain(`'\\''%s'\\''`);
  });
});
