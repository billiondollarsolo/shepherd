/**
 * CodeEditor — a real code editor for the file panel (Orca/hive parity), built on
 * CodeMirror 6 via @uiw/react-codemirror. Syntax highlighting (language picked by
 * file extension), line numbers, and the One Dark theme that matches the paddock's
 * terminal palette. Used for BOTH viewing (read-only, still highlighted) and
 * editing — `onChange`/`readOnly` switch the mode.
 */
import { useMemo } from 'react';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
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

export interface CodeEditorProps {
  value: string;
  /** Filename (or path) — drives syntax highlighting by extension. */
  filename: string;
  /** Edit handler. When omitted, the editor is read-only (a highlighted viewer). */
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export function CodeEditor({ value, filename, onChange, readOnly }: CodeEditorProps): JSX.Element {
  const extensions = useMemo(() => {
    const lang = languageFor(filename);
    return lang ? [lang] : [];
  }, [filename]);

  return (
    <CodeMirror
      data-testid="file-editor"
      value={value}
      theme={oneDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={onChange}
      height="100%"
      style={{ height: '100%', fontSize: 12 }}
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
