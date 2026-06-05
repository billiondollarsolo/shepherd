/**
 * Reusable NodeTransport CONTRACT suite (US-7, spec §15: "write the contract
 * suite once, run twice").
 *
 * This module exports `runTransportContract(name, factory)` which registers a
 * full `describe` block of behavioural assertions every `NodeTransport` MUST
 * satisfy. LocalTransport (US-7) and SshTransport (US-8) each call it with their
 * own factory; the SAME assertions run against both — that is the whole point of
 * the seam.
 *
 * It is deliberately NOT named `*.test.ts`: it is imported BY tests so the same
 * battery executes under both unit (Local, in-process) and integration (SSH,
 * dockerized sshd) configs. Tests pulling it in:
 *   - local-transport.test.ts       (unit, in `pnpm test:unit`)
 *   - ssh-transport.int.test.ts     (integration, US-8)
 */
import { describe, expect, it } from 'vitest';

import type { NodeTransport } from './transport.js';
import { TransportDisposedError } from './transport.js';

/** Produces a fresh transport for each assertion (and disposes it after). */
export type TransportFactory = () => NodeTransport | Promise<NodeTransport>;

/** Collects PTY output until a predicate is met or a deadline elapses. */
function waitForData(
  handle: { onData(l: (c: string) => void): () => void },
  predicate: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for PTY data. Got: ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    const off = handle.onData((chunk) => {
      buffer += chunk;
      if (predicate(buffer)) {
        clearTimeout(timer);
        off();
        resolve(buffer);
      }
    });
  });
}

/** Resolves when the PTY exits or a deadline elapses. */
function waitForExit(
  handle: {
    onExit(l: (e: { exitCode: number | null; signal: string | null }) => void): () => void;
  },
  timeoutMs = 5000,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for PTY exit.'));
    }, timeoutMs);
    const off = handle.onExit((event) => {
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

/**
 * Registers the shared contract `describe` block.
 *
 * @param name    label for the implementation under test (e.g. "LocalTransport").
 * @param factory builds a fresh transport per test.
 */
export function runTransportContract(name: string, factory: TransportFactory): void {
  describe(`NodeTransport contract — ${name}`, () => {
    async function withTransport<T>(fn: (t: NodeTransport) => Promise<T>): Promise<T> {
      const transport = await factory();
      try {
        return await fn(transport);
      } finally {
        await transport.dispose();
      }
    }

    // -- exec -------------------------------------------------------------

    it('reports a transport kind', async () => {
      await withTransport(async (t) => {
        expect(['local', 'ssh']).toContain(t.kind);
      });
    });

    it('exec runs a command and captures stdout + a zero exit code', async () => {
      await withTransport(async (t) => {
        const result = await t.exec(['printf', 'hello-flock']);
        expect(result.exitCode).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toContain('hello-flock');
        expect(result.timedOut).toBe(false);
      });
    });

    it('exec captures stderr and a non-zero exit code on failure', async () => {
      await withTransport(async (t) => {
        // `sh -c` so both local and ssh interpret the redirection identically.
        const result = await t.exec(['sh', '-c', 'echo oops 1>&2; exit 3']);
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain('oops');
      });
    });

    it('exec honours cwd', async () => {
      await withTransport(async (t) => {
        const result = await t.exec(['pwd'], { cwd: '/' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('/');
      });
    });

    it('exec honours env', async () => {
      await withTransport(async (t) => {
        const result = await t.exec(['sh', '-c', 'echo "$FLOCK_TEST_VAR"'], {
          env: { FLOCK_TEST_VAR: 'courier' },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('courier');
      });
    });

    it('exec forwards stdin via input', async () => {
      await withTransport(async (t) => {
        const result = await t.exec(['cat'], { input: 'piped-in\n' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('piped-in');
      });
    });

    it('exec enforces timeoutMs and flags timedOut', async () => {
      await withTransport(async (t) => {
        const result = await t.exec(['sh', '-c', 'sleep 5'], { timeoutMs: 300 });
        expect(result.timedOut).toBe(true);
        // Killed → no clean zero exit.
        expect(result.exitCode).not.toBe(0);
      });
    });

    it('exec rejects an empty command', async () => {
      await withTransport(async (t) => {
        await expect(t.exec([])).rejects.toThrow();
      });
    });

    // -- openPty ----------------------------------------------------------

    it('openPty streams program output via onData', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['sh', '-c', 'echo pty-says-hi; exit 0'] });
        const out = await waitForData(pty, (b) => b.includes('pty-says-hi'));
        expect(out).toContain('pty-says-hi');
        pty.kill();
      });
    });

    it('openPty echoes interactive input back through the tty', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['cat'] });
        pty.write('roundtrip\n');
        // A PTY echoes typed input by default; we should see it on the stream.
        const out = await waitForData(pty, (b) => b.includes('roundtrip'));
        expect(out).toContain('roundtrip');
        pty.kill();
      });
    });

    it('openPty fires onExit with the program exit code', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['sh', '-c', 'exit 0'] });
        const exit = await waitForExit(pty);
        expect(exit.exitCode).toBe(0);
      });
    });

    it('openPty honours cwd', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['sh', '-c', 'pwd; exit 0'], cwd: '/' });
        const out = await waitForData(pty, (b) => b.includes('\n'));
        // First line is the cwd echoed by pwd.
        expect(out.split('\n')[0]?.trim()).toBe('/');
        pty.kill();
      });
    });

    it('openPty honours env', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({
          command: ['sh', '-c', 'echo "$FLOCK_PTY_VAR"; exit 0'],
          env: { FLOCK_PTY_VAR: 'pty-env-value' },
        });
        const out = await waitForData(pty, (b) => b.includes('pty-env-value'));
        expect(out).toContain('pty-env-value');
        pty.kill();
      });
    });

    it('openPty kill terminates the program', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['sh', '-c', 'sleep 30'] });
        const exitPromise = waitForExit(pty);
        pty.kill();
        // The meaningful contract is that kill() causes the program to exit.
        // (A signalled PTY may report exitCode 0 with a signal on some
        // platforms, so we assert termination, not a specific code.)
        const exit = await exitPromise;
        expect(exit).toBeDefined();
        expect(exit.exitCode !== 0 || exit.signal !== null).toBe(true);
      });
    });

    it('openPty late onExit subscribers still receive the result', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['sh', '-c', 'exit 0'] });
        await waitForExit(pty); // ensure it has already exited
        // Subscribe AFTER exit; must still be notified (replay of recorded exit).
        const late = await waitForExit(pty);
        expect(late.exitCode).toBe(0);
      });
    });

    it('onData unsubscribe stops further delivery', async () => {
      await withTransport(async (t) => {
        const pty = await t.openPty({ command: ['cat'] });
        let received = '';
        const off = pty.onData((c) => {
          received += c;
        });
        off();
        pty.write('should-not-arrive\n');
        // Give the PTY a moment; nothing should be appended after unsubscribe.
        await new Promise((r) => setTimeout(r, 200));
        expect(received).not.toContain('should-not-arrive');
        pty.kill();
      });
    });

    // -- dispose ----------------------------------------------------------

    it('dispose is idempotent', async () => {
      const transport = await factory();
      await transport.dispose();
      await expect(transport.dispose()).resolves.toBeUndefined();
    });

    it('rejects exec after dispose', async () => {
      const transport = await factory();
      await transport.dispose();
      await expect(transport.exec(['true'])).rejects.toBeInstanceOf(TransportDisposedError);
    });

    it('rejects openPty after dispose', async () => {
      const transport = await factory();
      await transport.dispose();
      await expect(transport.openPty({ command: ['sh'] })).rejects.toBeInstanceOf(
        TransportDisposedError,
      );
    });

    it('dispose kills outstanding PTYs', async () => {
      const transport = await factory();
      const pty = await transport.openPty({ command: ['sh', '-c', 'sleep 30'] });
      const exitPromise = waitForExit(pty, 5000);
      await transport.dispose();
      // Disposing the transport must terminate the live PTY.
      const exit = await exitPromise;
      expect(exit).toBeDefined();
    });
  });
}
