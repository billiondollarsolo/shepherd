import { describe, expect, it } from 'vitest';

import { ORCHESTRATION_SCOPES } from './orchestrate-service.js';

describe('orchestration endpoint capability matrix', () => {
  it('assigns every operation the least privileged explicit scope', () => {
    expect(ORCHESTRATION_SCOPES).toEqual({
      list: 'agents:list:project',
      wait: 'agents:read:project',
      read: 'agents:read:project',
      send: 'agents:send:project',
      spawn: 'agents:spawn:project',
      kill: 'agents:terminate:project',
      restart: ['agents:terminate:project', 'agents:spawn:project'],
    });
  });
});
