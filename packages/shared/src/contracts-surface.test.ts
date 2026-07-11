import { describe, expect, it } from 'vitest';
import * as contracts from './contracts';

describe('public contract domains', () => {
  it('keeps canonical runtime schemas available through the stable contracts entrypoint', () => {
    expect(Object.keys(contracts)).toEqual(
      expect.arrayContaining([
        'LoginRequest',
        'CreateNodeRequest',
        'CreateProjectRequest',
        'CreateSessionRequest',
        'GitStatusResponse',
        'PushSubscribeRequest',
        'ListAuditResponse',
        'StatusUpdateMessage',
        'ErrorResponse',
      ]),
    );
    expect(new Set(Object.keys(contracts)).size).toBe(Object.keys(contracts).length);
  });
});
