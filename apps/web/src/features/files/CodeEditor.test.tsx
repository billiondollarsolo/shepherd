/**
 * CodeEditor — theme-awareness prop test (Phase 4.2).
 *
 * jsdom cannot lay out / measure a real CodeMirror editor (no layout engine), so
 * this is a deliberately SHALLOW test: `@uiw/react-codemirror` is mocked to a stub
 * that captures the props CodeEditor hands it. We assert the theme wiring instead
 * of pixels — that dark drives One Dark, light drives the default light + our
 * token-built chrome extension, and that the chrome extension re-derives (with the
 * right `dark` flag) from `useTheme().resolvedTheme`. A full visual pass (real
 * colours on the surface) is covered by the light/dark manual review, not jsdom.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { ThemeProvider } from '../../theme/ThemeProvider';

// Sentinels so we can identify which theme CodeEditor selected by reference.
const ONE_DARK = { __sentinel: 'oneDark' } as const;

// Capture holder (hoisted so the vi.mock factory can close over it).
const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: ONE_DARK }));

vi.mock('@uiw/react-codemirror', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    captured.props = props;
    return <div data-testid="cm-stub" />;
  },
  // EditorView.theme(spec, opts) — return a tagged object so tests can inspect the
  // `dark` flag the component passed for the current resolved theme.
  EditorView: {
    theme: (spec: unknown, opts: { dark?: boolean }) => ({ __flockTheme: true, spec, opts }),
  },
}));

// Imported after the mocks are registered.
const { CodeEditor } = await import('./CodeEditor');

function renderInTheme(mode: 'light' | 'dark') {
  return render(
    <ThemeProvider defaultMode={mode}>
      <CodeEditor value="const x = 1;" filename="example.ts" />
    </ThemeProvider>,
  );
}

/** The token/font chrome extension is always first in the extensions array. */
function chromeExt(): { __flockTheme: boolean; opts: { dark?: boolean } } {
  const exts = captured.props?.extensions as Array<{
    __flockTheme?: boolean;
    opts?: { dark?: boolean };
  }>;
  return exts[0] as { __flockTheme: boolean; opts: { dark?: boolean } };
}

afterEach(() => {
  cleanup();
  captured.props = null;
});

describe('CodeEditor theme-awareness', () => {
  it('uses One Dark and a dark-flagged chrome extension in dark mode', () => {
    renderInTheme('dark');
    expect(captured.props?.theme).toBe(ONE_DARK);
    const ext = chromeExt();
    expect(ext.__flockTheme).toBe(true);
    expect(ext.opts.dark).toBe(true);
  });

  it('uses the default light theme and a light-flagged chrome extension in light mode', () => {
    renderInTheme('light');
    // Light mode leans on CodeMirror's default light HighlightStyle...
    expect(captured.props?.theme).toBe('light');
    // ...but re-skins the chrome from the --flock-* tokens (not a dark island).
    const ext = chromeExt();
    expect(ext.__flockTheme).toBe(true);
    expect(ext.opts.dark).toBe(false);
  });

  it('drives the font/size off the code tokens (no hardcoded px / foreign family)', () => {
    renderInTheme('light');
    const spec = chromeExt() as unknown as { spec: Record<string, Record<string, string>> };
    expect(spec.spec['&'].fontSize).toBe('var(--flock-text-sm)');
    expect(spec.spec['.cm-content'].fontFamily).toBe('var(--flock-font-code)');
    // The editor surface matches the app chrome, not a foreign literal.
    expect(spec.spec['&'].backgroundColor).toBe('var(--flock-surface-0)');
    // No leftover hardcoded 12px font-size on the outer style.
    expect((captured.props?.style as Record<string, unknown>).fontSize).toBeUndefined();
  });
});
