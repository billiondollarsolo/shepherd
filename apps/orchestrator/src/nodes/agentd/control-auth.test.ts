import { describe, expect, it } from 'vitest';

import {
  controlCredentialId,
  controlMac,
  controlNonce,
  validControlNonce,
  verifyControlMac,
} from './control-auth.js';

describe('agentd v2 control authentication', () => {
  it('matches the shared Go/TypeScript vector', () => {
    expect(
      controlMac({
        credential: '0123456789abcdef0123456789abcdef',
        role: 'server',
        nodeId: 'node-1234',
        clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        daemonVersion: '0.3.0',
        capabilities: ['pty', 'resize', 'scrollback'],
      }),
    ).toBe('pSdsQrZCMrYUFj85DnoQGcbUl2Jjr7kiehtn60Voruc');
  });

  it('generates 256-bit nonces and compares MACs safely', () => {
    const nonce = controlNonce();
    expect(validControlNonce(nonce)).toBe(true);
    expect(validControlNonce('short')).toBe(false);
    expect(verifyControlMac('same', 'same')).toBe(true);
    expect(verifyControlMac('same', 'different')).toBe(false);
  });

  it('matches the Go credential selector', () => {
    expect(controlCredentialId('0123456789abcdef0123456789abcdef')).toBe(
      '3eb1bd439947eb762998e566ccc2e099',
    );
  });
});
