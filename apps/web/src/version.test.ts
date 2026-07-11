import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOCK_VERSION } from './version';

describe('FLOCK_VERSION', () => {
  it('is injected from the canonical repository version file', () => {
    const canonical = readFileSync(resolve(process.cwd(), '../../agentd/VERSION'), 'utf8').trim();
    expect(FLOCK_VERSION).toBe(canonical);
  });
});
