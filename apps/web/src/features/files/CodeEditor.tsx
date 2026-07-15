/**
 * CodeEditor — a real code editor for the file panel (Orca/hive parity), built on
 * CodeMirror 6 via @uiw/react-codemirror. Syntax highlighting (language picked by
 * file extension), line numbers, and a THEME-AWARE palette: in dark mode it uses
 * One Dark; in light mode it builds its chrome from the `--flock-*` tokens so the
 * viewer never becomes a dark island in white chrome. The mono font/size are
 * driven from `--flock-font-code` + the text-sm scale so the terminal, editor,
 * and diff share one family and size. Used for BOTH viewing (read-only, still
 * highlighted) and editing — `onChange`/`readOnly` switch the mode.
 */
import { useMemo } from 'react';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';

import { useTheme } from '../../theme/useTheme';

/** Resolve a CodeMirror language extension from a filename, or none. */
function languageFor(filename: string): Extension | null {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ jsx: ext === 'tsx', typescript: true });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'py':
    case 'pyi':
      return python();
    case 'json':
    case 'jsonc':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return html();
    case 'rs':
      return rust();
    case 'go':
      return go();
    case 'yaml':
    case 'yml':
      return yaml();
    default:
      return null;
  }
}

/**
 * Shared chrome/font override, keyed only off the `--flock-*` tokens so it stays
 * correct in BOTH themes and re-themes live when the tokens flip.
 *
 * Layered as a user `extension` (applied AFTER the `theme` prop), so it wins over
 * both the light default and `oneDark`: the editor surface matches the app chrome
 * (surface-0), the mono family/size matches the terminal + diff, and the caret,
 * selection, gutter, and active-line all read from tokens. In dark mode oneDark's
 * syntax HighlightStyle still supplies token colours on top of this surface.
 */
function flockEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--flock-surface-0)',
        color: 'var(--flock-ink-primary)',
        fontSize: 'var(--flock-text-sm)',
      },
      '.cm-content': {
        fontFamily: 'var(--flock-font-code)',
        caretColor: 'var(--flock-ink-primary)',
        lineHeight: 'var(--flock-leading-sm)',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--flock-ink-primary)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--flock-term-selection)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--flock-surface-0)',
        color: 'var(--flock-ink-muted)',
        border: 'none',
        borderRight: '1px solid var(--flock-border)',
        fontFamily: 'var(--flock-font-code)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--flock-surface-1)' },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--flock-surface-1)',
        color: 'var(--flock-ink-primary)',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--flock-surface-2)',
        color: 'var(--flock-ink-muted)',
        border: 'none',
      },
    },
    { dark },
  );
}

export interface CodeEditorProps {
  value: string;
  /** Filename (or path) — drives syntax highlighting by extension. */
  filename: string;
  /** Edit handler. When omitted, the editor is read-only (a highlighted viewer). */
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export function CodeEditor({ value, filename, onChange, readOnly }: CodeEditorProps): JSX.Element {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';

  const extensions = useMemo(() => {
    // The token/font override is a user extension so it wins over the `theme` prop.
    const exts: Extension[] = [flockEditorTheme(dark)];
    const lang = languageFor(filename);
    if (lang) exts.push(lang);
    return exts;
  }, [filename, dark]);

  return (
    <CodeMirror
      data-testid="file-editor"
      value={value}
      // Dark: One Dark's syntax HighlightStyle. Light: the default light
      // HighlightStyle. The `flockEditorTheme` extension re-skins the chrome
      // from tokens in both. Changing this prop re-themes live on toggle.
      theme={dark ? oneDark : 'light'}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={onChange}
      height="100%"
      style={{ height: '100%' }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        foldGutter: true,
        autocompletion: false,
      }}
    />
  );
}
