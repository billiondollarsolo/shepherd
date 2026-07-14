import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import type { Client } from 'ssh2';

import { describe, expect, it, vi } from 'vitest';

import { runtimeAwareRemoteCommand, SshTransport } from './ssh-transport.js';

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

describe('SshTransport.dialTcp', () => {
  it('uses SSH direct-tcpip for the exact selected loopback address and port', async () => {
    const channel = new PassThrough();
    const forwardOut = vi.fn(
      (
        _sourceHost: string,
        _sourcePort: number,
        _destinationHost: string,
        _destinationPort: number,
        callback: (error: Error | undefined, stream: PassThrough) => void,
      ) => {
        callback(undefined, channel);
        return true;
      },
    );
    const transport = new SshTransport({ forwardOut } as unknown as Client);
    await expect(transport.dialTcp(5173, '::1')).resolves.toBe(channel);
    expect(forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '::1', 5173, expect.any(Function));
    await transport.dispose();
  });
});
