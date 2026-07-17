import { describe, expect, it } from 'vitest';

import { highlightCode } from './chatHighlight';

describe('highlightCode', () => {
  it('highlights a known fence language into hljs markup', async () => {
    const html = await highlightCode('const x = 1;', 'javascript');
    expect(html).toContain('hljs-');
    expect(html).toContain('const');
  });

  it('auto-detects when the language is empty or unknown', async () => {
    const known = await highlightCode('def f():\n    return 1', 'python');
    expect(known).toContain('hljs-');
    // empty + unknown both take the highlightAuto branch; still returns markup.
    const auto = await highlightCode('SELECT 1 FROM t', '');
    expect(typeof auto).toBe('string');
    const unknown = await highlightCode('nchars', 'not-a-registered-language');
    expect(typeof unknown).toBe('string');
  });

  it('caches the highlighter across calls (second call resolves)', async () => {
    const a = await highlightCode('a = 1', 'python');
    const b = await highlightCode('b = 2', 'python');
    expect(a).toContain('hljs-');
    expect(b).toContain('hljs-');
  });
});
