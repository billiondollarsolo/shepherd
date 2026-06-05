/**
 * US-28 — Layer C input takeover/release: client-side input translation.
 *
 * Pure helpers that turn DOM pointer/keyboard events into the CDP-shaped input
 * intents the orchestrator forwards to chrome (`InputTakeoverController.forward`).
 * Kept pure + DOM-light so they unit-test without a browser; the React control
 * (`BrowserControl`) wires real DOM events to them.
 *
 * Coordinates: the screencast frame is rendered into an element of known on-
 * screen size, but chrome captured it at the device viewport size
 * (`metadata.deviceWidth/Height`). We map a pointer position in the rendered
 * element back to CSS px in chrome's viewport so a click lands where the user
 * sees it.
 */

import type {
  CdpKeyEventParams,
  CdpMouseEventParams,
  InputIntent,
} from '@flock/shared';

/** The rendered element rect + the source frame's device size, for mapping. */
export interface ViewportMapping {
  /** Rendered element width in CSS px (e.g. the <img> client width). */
  renderedWidth: number;
  /** Rendered element height in CSS px. */
  renderedHeight: number;
  /** Frame device width chrome captured at (metadata.deviceWidth). */
  deviceWidth: number;
  /** Frame device height chrome captured at (metadata.deviceHeight). */
  deviceHeight: number;
}

/** A pointer position relative to the rendered element's top-left, CSS px. */
export interface RenderedPoint {
  x: number;
  y: number;
}

/**
 * Map a pointer position in the rendered element to CSS px in chrome's viewport.
 * Degrades to identity when the rendered size is zero/unknown (avoids div-by-0).
 */
export function mapPointToViewport(
  point: RenderedPoint,
  mapping: ViewportMapping,
): { x: number; y: number } {
  const sx =
    mapping.renderedWidth > 0 ? mapping.deviceWidth / mapping.renderedWidth : 1;
  const sy =
    mapping.renderedHeight > 0
      ? mapping.deviceHeight / mapping.renderedHeight
      : 1;
  return {
    x: Math.round(point.x * sx),
    y: Math.round(point.y * sy),
  };
}

/** DOM `MouseEvent.button` (0=left,1=middle,2=right) → CDP button name. */
export function cdpButton(domButton: number): CdpMouseEventParams['button'] {
  switch (domButton) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    case 3:
      return 'back';
    case 4:
      return 'forward';
    default:
      return 'none';
  }
}

/** Modifier bitfield from a DOM event (Alt=1, Ctrl=2, Meta=4, Shift=8). */
export function cdpModifiers(e: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  );
}

/** Build a click-down/up pair (or move) mouse intent at a mapped viewport point. */
export function mouseIntent(params: {
  type: CdpMouseEventParams['type'];
  point: { x: number; y: number };
  button?: number;
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}): InputIntent {
  const event: CdpMouseEventParams = {
    type: params.type,
    x: params.point.x,
    y: params.point.y,
  };
  if (params.button !== undefined) event.button = cdpButton(params.button);
  if (params.clickCount !== undefined) event.clickCount = params.clickCount;
  if (params.modifiers !== undefined) event.modifiers = params.modifiers;
  if (params.deltaX !== undefined) event.deltaX = params.deltaX;
  if (params.deltaY !== undefined) event.deltaY = params.deltaY;
  return { kind: 'mouse', event };
}

/** Build a scroll (mouseWheel) intent at a mapped viewport point. */
export function scrollIntent(params: {
  point: { x: number; y: number };
  deltaX: number;
  deltaY: number;
  modifiers?: number;
}): InputIntent {
  return mouseIntent({
    type: 'mouseWheel',
    point: params.point,
    deltaX: params.deltaX,
    deltaY: params.deltaY,
    modifiers: params.modifiers,
  });
}

/** Build a key intent from a DOM-like keyboard event descriptor. */
export function keyIntent(params: {
  type: CdpKeyEventParams['type'];
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}): InputIntent {
  const event: CdpKeyEventParams = { type: params.type };
  if (params.key !== undefined) event.key = params.key;
  if (params.code !== undefined) event.code = params.code;
  if (params.text !== undefined) event.text = params.text;
  if (params.modifiers !== undefined) event.modifiers = params.modifiers;
  return { kind: 'key', event };
}
