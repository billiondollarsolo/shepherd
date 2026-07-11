import { describe, expect, it } from 'vitest';
import { formatEnvText, parseEnvText } from './envText';

describe('dialog environment text', () => {
  it('parses values containing equals and ignores comments or malformed rows', () => {
    expect(parseEnvText('A=one\n# note\ninvalid\nTOKEN=a=b=c\n =empty')).toEqual({
      A: 'one',
      TOKEN: 'a=b=c',
    });
  });

  it('round-trips an environment map', () => {
    const env = { LANG: 'en_US.UTF-8', API_URL: 'https://example.test?a=b' };
    expect(parseEnvText(formatEnvText(env))).toEqual(env);
  });
});
