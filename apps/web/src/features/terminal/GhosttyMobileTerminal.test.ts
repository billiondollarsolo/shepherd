import { describe, expect, it, vi } from 'vitest';
import {
  disableMobileCanvasScrollbar,
  fitMobileTerminal,
  forceTerminalTextPresentation,
  installMobileTextSymbolRendering,
  installMobileTouch,
} from './GhosttyMobileTerminal';

function touchEvent(type: string, x: number, y: number): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
  });
  return event;
}

function setup(): {
  element: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  scrollLines: ReturnType<typeof vi.fn>;
  cleanup: () => void;
} {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.disabled = true;
  document.body.append(element, textarea);
  const scrollLines = vi.fn();
  const cleanup = installMobileTouch(
    {
      element,
      textarea,
      renderer: { getMetrics: () => ({ height: 10 }) },
      scrollLines,
      scrollToBottom: vi.fn(),
    },
    { fit: vi.fn() },
  );
  return { element, textarea, scrollLines, cleanup };
}

describe('Ghostty mobile touch bridge', () => {
  it('never focuses the keyboard after a scroll gesture', () => {
    const { element, textarea, scrollLines, cleanup } = setup();
    element.dispatchEvent(touchEvent('touchstart', 10, 100));
    element.dispatchEvent(touchEvent('touchmove', 10, 70));
    element.dispatchEvent(touchEvent('touchend', 10, 70));

    expect(scrollLines).toHaveBeenCalled();
    expect(textarea.disabled).toBe(true);
    expect(document.activeElement).not.toBe(textarea);
    cleanup();
  });

  it('focuses the keyboard only after a clean tap', () => {
    const { element, textarea, cleanup } = setup();
    element.dispatchEvent(touchEvent('touchstart', 10, 100));
    element.dispatchEvent(touchEvent('touchend', 10, 100));

    expect(textarea.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);
    cleanup();
  });
});

describe('Ghostty mobile viewport fitting', () => {
  it('uses the visible viewport instead of an oversized layout container', () => {
    const parent = document.createElement('div');
    const element = document.createElement('div');
    parent.append(element);
    document.body.append(parent);
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 500 });
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 0,
      left: 10,
      right: 510,
      top: 0,
      bottom: 500,
      width: 500,
      height: 500,
      toJSON: () => ({}),
    });
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390 },
    });
    const fit = vi.fn();

    fitMobileTerminal({ element }, { fit });

    expect(element.style.width).toBe('380px');
    expect(element.style.maxWidth).toBe('100%');
    expect(fit).toHaveBeenCalledOnce();
    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
  });
});

describe('Ghostty mobile scrollbar', () => {
  it('suppresses the canvas overlay that covers the final terminal columns', () => {
    const renderScrollbar = vi.fn();
    const terminal = { renderer: { renderScrollbar } };

    disableMobileCanvasScrollbar(terminal);
    terminal.renderer.renderScrollbar();

    expect(renderScrollbar).not.toHaveBeenCalled();
  });
});

describe('Ghostty mobile symbol rendering', () => {
  it('forces Claude mode symbols to monochrome text presentation', () => {
    expect(forceTerminalTextPresentation('\u23f8')).toBe('\u23f8\ufe0e');
    expect(forceTerminalTextPresentation('\u23f8\ufe0f')).toBe('\u23f8\ufe0e');
    expect(forceTerminalTextPresentation('plain text')).toBe('plain text');
  });

  it('normalizes symbols only at canvas paint time', () => {
    const fillText = vi.fn();
    const terminal = { renderer: { ctx: { fillText } } };

    installMobileTextSymbolRendering(terminal);
    terminal.renderer.ctx.fillText('\u23f8', 10, 20);

    expect(fillText).toHaveBeenCalledWith('\u23f8\ufe0e', 10, 20);
  });
});
