import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { decryptVaultPayload, encryptVaultPayload } from './vault-format';

describe('Shepherd vault authenticated format', () => {
  it('round-trips a payload without storing its plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flock-vault-format-'));
    const source = join(dir, 'source');
    const vault = join(dir, 'backup.flockvault');
    const restored = join(dir, 'restored');
    const secret = Buffer.from('canary-secret-database-payload');
    await writeFile(source, secret);
    await encryptVaultPayload(source, vault, Buffer.from('correct horse battery staple'));
    expect((await readFile(vault)).includes(secret)).toBe(false);
    await decryptVaultPayload(vault, restored, Buffer.from('correct horse battery staple'));
    expect(await readFile(restored)).toEqual(secret);
  });

  it('rejects wrong passwords and tampering without a partial output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flock-vault-format-'));
    const source = join(dir, 'source');
    const vault = join(dir, 'backup.flockvault');
    await writeFile(source, 'payload');
    await encryptVaultPayload(source, vault, Buffer.from('right-password'));
    await expect(
      decryptVaultPayload(vault, join(dir, 'wrong'), Buffer.from('wrong-password')),
    ).rejects.toThrow(/authentication failed/);
    const bytes = await readFile(vault);
    bytes[Math.floor(bytes.length / 2)]! ^= 1;
    await writeFile(vault, bytes);
    await expect(
      decryptVaultPayload(vault, join(dir, 'tampered'), Buffer.from('right-password')),
    ).rejects.toThrow(/authentication failed/);
  });

  it('never deletes a pre-existing destination when exclusive creation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flock-vault-format-'));
    const source = join(dir, 'source');
    const vault = join(dir, 'backup.flockvault');
    const destination = join(dir, 'existing');
    await writeFile(source, 'payload');
    await writeFile(destination, 'operator-data');
    await encryptVaultPayload(source, vault, Buffer.from('right-password'));
    await expect(
      decryptVaultPayload(vault, destination, Buffer.from('right-password')),
    ).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('operator-data');
  });
});
