import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { appendFile, open, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const MAGIC = Buffer.from('FLOCKVAULT1\n', 'ascii');
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;

const HeaderSchema = z
  .object({
    cipher: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    salt: z.string().min(20).max(64),
    iv: z.string().min(12).max(32),
    n: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
  })
  .strict();

function derive(password: Buffer, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function encryptVaultPayload(
  input: string,
  output: string,
  password: Buffer,
): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(password, salt);
  const header = Buffer.from(
    JSON.stringify({
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      n: 32768,
      r: 8,
      p: 1,
    }),
  );
  const prefix = Buffer.alloc(MAGIC.length + 4 + header.length);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(header.length, MAGIC.length);
  header.copy(prefix, MAGIC.length + 4);
  const handle = await open(output, 'wx', 0o600);
  try {
    await handle.write(prefix);
  } finally {
    await handle.close();
  }
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(prefix);
  try {
    await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'a' }));
    await appendFile(output, cipher.getAuthTag());
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function decryptVaultPayload(
  input: string,
  output: string,
  password: Buffer,
): Promise<void> {
  const handle = await open(input, 'r');
  try {
    const stat = await handle.stat();
    const fixed = Buffer.alloc(MAGIC.length + 4);
    await handle.read(fixed, 0, fixed.length, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Shepherd vault');
    const headerLength = fixed.readUInt32BE(MAGIC.length);
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES)
      throw new Error('Invalid vault header');
    const headerBytes = Buffer.alloc(headerLength);
    await handle.read(headerBytes, 0, headerLength, fixed.length);
    const header = HeaderSchema.parse(JSON.parse(headerBytes.toString('utf8')));
    const payloadStart = fixed.length + headerLength;
    const payloadEnd = stat.size - TAG_BYTES - 1;
    if (payloadEnd < payloadStart) throw new Error('Truncated Shepherd vault');
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
    const key = derive(password, Buffer.from(header.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(Buffer.concat([fixed, headerBytes]));
    decipher.setAuthTag(tag);
    let outputCreated = false;
    const outputStream = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    outputStream.once('open', () => {
      outputCreated = true;
    });
    try {
      await pipeline(
        createReadStream(input, { start: payloadStart, end: payloadEnd }),
        decipher,
        outputStream,
      );
    } catch (error) {
      if (outputCreated) await rm(output, { force: true });
      throw new Error('Vault authentication failed (wrong password or corrupt archive)', {
        cause: error,
      });
    } finally {
      key.fill(0);
    }
  } finally {
    await handle.close();
  }
}
