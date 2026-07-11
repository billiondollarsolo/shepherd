import { describe, expect, it } from 'vitest';
import {
  cdpButton,
  cdpModifiers,
  keyIntent,
  mapPointToViewport,
  mouseIntent,
  scrollIntent,
} from './browserInput.js';

/**
 * US-28 — client-side input translation (Layer C takeover).
 * Pure mapping helpers: pointer→viewport, DOM button/modifiers→CDP, intent build.
 */

describe('mapPointToViewport', () => {
  it('scales a rendered point up to the captured device viewport', () => {
    const out = mapPointToViewport(
      { x: 100, y: 50 },
      { renderedWidth: 640, renderedHeight: 360, deviceWidth: 1280, deviceHeight: 720 },
    );
    expect(out).toEqual({ x: 200, y: 100 });
  });

  it('is identity when rendered size matches device size', () => {
    const out = mapPointToViewport(
      { x: 33, y: 44 },
      { renderedWidth: 800, renderedHeight: 600, deviceWidth: 800, deviceHeight: 600 },
    );
    expect(out).toEqual({ x: 33, y: 44 });
  });

  it('falls back to identity (no div-by-zero) when rendered size is zero', () => {
    const out = mapPointToViewport(
      { x: 10, y: 20 },
      { renderedWidth: 0, renderedHeight: 0, deviceWidth: 1280, deviceHeight: 720 },
    );
    expect(out).toEqual({ x: 10, y: 20 });
  });
});

describe('cdpButton', () => {
  it('maps DOM mouse buttons to CDP names', () => {
    expect(cdpButton(0)).toBe('left');
    expect(cdpButton(1)).toBe('middle');
    expect(cdpButton(2)).toBe('right');
    expect(cdpButton(9)).toBe('none');
  });
});

describe('cdpModifiers', () => {
  it('builds the CDP modifier bitfield (Alt=1,Ctrl=2,Meta=4,Shift=8)', () => {
    expect(cdpModifiers({})).toBe(0);
    expect(cdpModifiers({ shiftKey: true })).toBe(8);
    expect(cdpModifiers({ ctrlKey: true, metaKey: true })).toBe(6);
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});

describe('mouseIntent', () => {
  it('builds a left click-down intent at the mapped point', () => {
    const intent = mouseIntent({
      type: 'mousePressed',
      point: { x: 200, y: 100 },
      button: 0,
      clickCount: 1,
      modifiers: 0,
    });
    expect(intent).toEqual({
      kind: 'mouse',
      event: {
        type: 'mousePressed',
        x: 200,
        y: 100,
        button: 'left',
        clickCount: 1,
        modifiers: 0,
      },
    });
  });

  it('omits optional fields it was not given', () => {
    const intent = mouseIntent({ type: 'mouseMoved', point: { x: 1, y: 2 } });
    expect(intent).toEqual({
      kind: 'mouse',
      event: { type: 'mouseMoved', x: 1, y: 2 },
    });
  });
});

describe('scrollIntent', () => {
  it('builds a mouseWheel intent carrying scroll deltas', () => {
    const intent = scrollIntent({ point: { x: 5, y: 6 }, deltaX: 0, deltaY: 120 });
    expect(intent).toEqual({
      kind: 'mouse',
      event: { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 120 },
    });
  });
});

describe('keyIntent', () => {
  it('builds a keyDown intent carrying key/code/text', () => {
    const intent = keyIntent({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
    expect(intent).toEqual({
      kind: 'key',
      event: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' },
    });
  });

  it('carries modifiers when supplied', () => {
    const intent = keyIntent({ type: 'keyDown', key: 'Enter', modifiers: 2 });
    expect(intent).toEqual({
      kind: 'key',
      event: { type: 'keyDown', key: 'Enter', modifiers: 2 },
    });
  });
});
