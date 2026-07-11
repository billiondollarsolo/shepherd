import { describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEntry } from '../../audit/index.js';
import { InputTakeoverController } from './input-controller.js';
import { NotInControlError, TakeoverConflictError, type CdpInputClient } from './input-types.js';

/**
 * US-28 — Layer C input takeover/release (FR-B4, FR-A3).
 *
 * Acceptance:
 *  - `takeover` forwards click/scroll/keys as CDP Input events;
 *  - `release` stops forwarding;
 *  - single-controller: a second takeover is rejected (or queued) while one
 *    controller holds the lock (spec §10 edge case);
 *  - a `browser_takeover` audit row is written on takeover (FR-A3).
 *
 * Pinned with a fake CDP `Input` client + an in-memory audit sink (no real
 * chrome / DB), mirroring the screencast manager's unit-test style.
 */

interface FakeInputClient extends CdpInputClient {
  mouse: Array<Parameters<CdpInputClient['Input']['dispatchMouseEvent']>[0]>;
  keys: Array<Parameters<CdpInputClient['Input']['dispatchKeyEvent']>[0]>;
}

function makeFakeInputClient(): FakeInputClient {
  const client: FakeInputClient = {
    mouse: [],
    keys: [],
    Input: {
      async dispatchMouseEvent(params) {
        client.mouse.push(params);
      },
      async dispatchKeyEvent(params) {
        client.keys.push(params);
      },
    },
  };
  return client;
}

function makeAudit(): { logger: AuditLogger; rows: AuditEntry[] } {
  const rows: AuditEntry[] = [];
  const logger = new AuditLogger({
    async write(entry) {
      rows.push(entry);
    },
  });
  return { logger, rows };
}

const SID = '33333333-3333-4333-8333-333333333333';
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function ctl(overrides?: { client?: FakeInputClient; audit?: AuditLogger }) {
  const client = overrides?.client ?? makeFakeInputClient();
  const audit = overrides?.audit ?? makeAudit().logger;
  const controller = new InputTakeoverController({
    resolveInputClient: async () => client,
    audit,
  });
  return { controller, client };
}

describe('InputTakeoverController — takeover/release (US-28)', () => {
  it('nobody is in control before a takeover', () => {
    const { controller } = ctl();
    expect(controller.isControlled(SID)).toBe(false);
    expect(controller.controllerOf(SID)).toBeUndefined();
  });

  it('takeover grants the single control lock to the requester', async () => {
    const { controller } = ctl();
    const res = await controller.takeover(SID, { controllerId: USER_A });

    expect(res.inControl).toBe(true);
    expect(controller.isControlled(SID)).toBe(true);
    expect(controller.controllerOf(SID)).toBe(USER_A);
  });

  it('writes a browser_takeover audit row on takeover (FR-A3)', async () => {
    const { rows, logger } = makeAudit();
    const { controller } = ctl({ audit: logger });

    await controller.takeover(SID, { controllerId: USER_A, ip: '10.0.0.9' });

    const takeoverRows = rows.filter((r) => r.action === 'browser_takeover');
    expect(takeoverRows).toHaveLength(1);
    expect(takeoverRows[0]).toMatchObject({
      action: 'browser_takeover',
      targetType: 'session',
      targetId: SID,
      userId: USER_A,
      ip: '10.0.0.9',
    });
  });

  it('forwards a click as a CDP Input.dispatchMouseEvent while in control', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await controller.takeover(SID, { controllerId: USER_A });

    await controller.forward(SID, USER_A, {
      kind: 'mouse',
      event: { type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 },
    });
    await controller.forward(SID, USER_A, {
      kind: 'mouse',
      event: { type: 'mouseReleased', x: 12, y: 34, button: 'left', clickCount: 1 },
    });

    expect(client.mouse).toEqual([
      { type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 12, y: 34, button: 'left', clickCount: 1 },
    ]);
  });

  it('forwards a scroll as a CDP mouseWheel event while in control', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await controller.takeover(SID, { controllerId: USER_A });

    await controller.forward(SID, USER_A, {
      kind: 'mouse',
      event: { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 120 },
    });

    expect(client.mouse).toEqual([{ type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 120 }]);
  });

  it('forwards keys as CDP Input.dispatchKeyEvent while in control', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await controller.takeover(SID, { controllerId: USER_A });

    await controller.forward(SID, USER_A, {
      kind: 'key',
      event: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' },
    });

    expect(client.keys).toEqual([{ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }]);
  });

  it('single-controller: a second takeover by a different client is REJECTED', async () => {
    const { controller } = ctl();
    await controller.takeover(SID, { controllerId: USER_A });

    await expect(controller.takeover(SID, { controllerId: USER_B })).rejects.toBeInstanceOf(
      TakeoverConflictError,
    );

    // The original controller still holds the lock.
    expect(controller.controllerOf(SID)).toBe(USER_A);
  });

  it('re-takeover by the SAME controller is idempotent (no conflict, one audit row)', async () => {
    const { rows, logger } = makeAudit();
    const { controller } = ctl({ audit: logger });

    await controller.takeover(SID, { controllerId: USER_A });
    const res = await controller.takeover(SID, { controllerId: USER_A });

    expect(res.inControl).toBe(true);
    expect(controller.controllerOf(SID)).toBe(USER_A);
    expect(rows.filter((r) => r.action === 'browser_takeover')).toHaveLength(1);
  });

  it('release stops forwarding: post-release input is rejected and never reaches CDP', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await controller.takeover(SID, { controllerId: USER_A });

    const released = await controller.release(SID, USER_A);
    expect(released).toBe(true);
    expect(controller.isControlled(SID)).toBe(false);

    await expect(
      controller.forward(SID, USER_A, {
        kind: 'mouse',
        event: { type: 'mousePressed', x: 1, y: 2, button: 'left' },
      }),
    ).rejects.toBeInstanceOf(NotInControlError);
    expect(client.mouse).toHaveLength(0);
  });

  it('after release, a different client CAN take over (lock is free)', async () => {
    const { controller } = ctl();
    await controller.takeover(SID, { controllerId: USER_A });
    await controller.release(SID, USER_A);

    const res = await controller.takeover(SID, { controllerId: USER_B });
    expect(res.inControl).toBe(true);
    expect(controller.controllerOf(SID)).toBe(USER_B);
  });

  it('a non-controller cannot forward input (rejected, nothing forwarded)', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await controller.takeover(SID, { controllerId: USER_A });

    await expect(
      controller.forward(SID, USER_B, {
        kind: 'key',
        event: { type: 'keyDown', key: 'x' },
      }),
    ).rejects.toBeInstanceOf(NotInControlError);
    expect(client.keys).toHaveLength(0);
  });

  it('release by a non-controller is a no-op and does NOT free the lock', async () => {
    const { controller } = ctl();
    await controller.takeover(SID, { controllerId: USER_A });

    const released = await controller.release(SID, USER_B);
    expect(released).toBe(false);
    expect(controller.controllerOf(SID)).toBe(USER_A);
  });

  it('release of an uncontrolled session is a harmless no-op', async () => {
    const { controller } = ctl();
    expect(await controller.release(SID, USER_A)).toBe(false);
  });

  it('forwarding before any takeover is rejected (no implicit control)', async () => {
    const client = makeFakeInputClient();
    const { controller } = ctl({ client });
    await expect(
      controller.forward(SID, USER_A, {
        kind: 'mouse',
        event: { type: 'mouseMoved', x: 0, y: 0 },
      }),
    ).rejects.toBeInstanceOf(NotInControlError);
    expect(client.mouse).toHaveLength(0);
  });

  it('an audit failure does not break takeover (audit is off the live path)', async () => {
    const failingAudit = new AuditLogger({
      async write() {
        throw new Error('db down');
      },
    });
    const { controller } = ctl({ audit: failingAudit });

    const res = await controller.takeover(SID, { controllerId: USER_A });
    expect(res.inControl).toBe(true);
    expect(controller.controllerOf(SID)).toBe(USER_A);
  });

  it('releaseAll clears every controller (orchestrator shutdown / terminate sweep)', async () => {
    const { controller } = ctl();
    const other = '44444444-4444-4444-8444-444444444444';
    await controller.takeover(SID, { controllerId: USER_A });
    await controller.takeover(other, { controllerId: USER_B });

    await controller.releaseAll();

    expect(controller.isControlled(SID)).toBe(false);
    expect(controller.isControlled(other)).toBe(false);
  });

  it('resolves the CDP input client lazily, once, per session takeover', async () => {
    const client = makeFakeInputClient();
    const resolveInputClient = vi.fn(async () => client);
    const controller = new InputTakeoverController({
      resolveInputClient,
      audit: makeAudit().logger,
    });

    await controller.takeover(SID, { controllerId: USER_A });
    await controller.forward(SID, USER_A, {
      kind: 'mouse',
      event: { type: 'mouseMoved', x: 1, y: 1 },
    });
    await controller.forward(SID, USER_A, {
      kind: 'mouse',
      event: { type: 'mouseMoved', x: 2, y: 2 },
    });

    // The client is resolved exactly once at takeover, not per forwarded event.
    expect(resolveInputClient).toHaveBeenCalledTimes(1);
  });
});
