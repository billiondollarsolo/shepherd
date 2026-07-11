import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getDatabaseUrl } from './client';

describe('getDatabaseUrl', () => {
  it('constructs a safely encoded recovery URL from the Compose password secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flock-db-url-'));
    const file = join(directory, 'password');
    await writeFile(file, 'p@ss:/word\n');
    expect(
      getDatabaseUrl({
        POSTGRES_PASSWORD_FILE: file,
        POSTGRES_USER: 'flock owner',
        POSTGRES_DB: 'flock',
        POSTGRES_HOST: 'postgres',
        POSTGRES_PORT: '5432',
      }),
    ).toBe('postgres://flock%20owner:p%40ss%3A%2Fword@postgres:5432/flock');
  });
});
