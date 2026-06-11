/**
 * KeyboardProvider — global keyboard model + shell UI state (US-30, Appendix A.2).
 *
 * Owns:
 *   - Cmd/Ctrl+K → open the command palette.
 *   - Cmd/Ctrl+J → toggle the bottom shell drawer.
 *   - Escape     → close the command palette.
 *
 * It renders the {@link CommandPalette} overlay and injects `drawerOpen` into a
 * child {@link AppShell} (the single shell instance) so the drawer region
 * appears/disappears. Children may consume {@link useShell} to register commands
 * or drive the same state from buttons (e.g. a palette item that toggles itself).
 *
 * Key events that originate from a text input / textarea / contentEditable are
 * ignored so the shortcuts never fight with typing (Appendix A.4 calm density).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { CommandPalette } from './CommandPalette';
import type { Command } from './commands';

export interface ShellContextValue {
  readonly paletteOpen: boolean;
  readonly drawerOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  toggleDrawer: () => void;
  /** Register palette commands; returns an unregister fn (call on unmount). */
  registerCommands: (commands: readonly Command[]) => () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** Access the shell keyboard/state controls. Throws outside KeyboardProvider. */
export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used within a KeyboardProvider');
  return ctx;
}

/** Like {@link useShell} but returns null outside a provider (safe for AppShell,
 *  which may render in tests without a KeyboardProvider). */
export function useShellOptional(): ShellContextValue | null {
  return useContext(ShellContext);
}

export interface KeyboardProviderProps {
  readonly children?: ReactNode;
  /** Extra commands available in the palette beyond the built-ins. */
  readonly commands?: readonly Command[];
}

/** True if the event target is a place the user is typing into. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

export function KeyboardProvider({
  children,
  commands: extraCommands = [],
}: KeyboardProviderProps): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [registered, setRegistered] = useState<readonly Command[]>([]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);

  const registerCommands = useCallback((cmds: readonly Command[]) => {
    setRegistered((prev) => [...prev, ...cmds]);
    return () => {
      setRegistered((prev) => prev.filter((c) => !cmds.includes(c)));
    };
  }, []);

  // Built-in commands always available; mirror the keyboard shortcuts.
  const builtins = useMemo<Command[]>(
    () => [
      {
        id: 'toggle-shell-drawer',
        title: 'Toggle shell drawer',
        shortcut: '⌘J',
        run: () => setDrawerOpen((v) => !v),
      },
    ],
    [],
  );

  const allCommands = useMemo(
    () => [...builtins, ...registered, ...extraCommands],
    [builtins, registered, extraCommands],
  );

  // Global key handling (Appendix A.2).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // Escape always closes the palette if open.
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      // Never hijack shortcuts while the user is typing.
      if (isEditableTarget(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (key === 'j') {
        e.preventDefault();
        setDrawerOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen]);

  const value = useMemo<ShellContextValue>(
    () => ({
      paletteOpen,
      drawerOpen,
      openPalette,
      closePalette,
      toggleDrawer,
      registerCommands,
    }),
    [paletteOpen, drawerOpen, openPalette, closePalette, toggleDrawer, registerCommands],
  );

  // AppShell reads drawerOpen from this context via useShellOptional() — the old
  // cloneElement prop-injection only reached a DIRECT AppShell child, but AppShell
  // is nested several levels down (LiveDataProvider/divs), so the drawer toggle was
  // a silent no-op. Context works regardless of nesting depth.
  return (
    <ShellContext.Provider value={value}>
      {children}
      <CommandPalette open={paletteOpen} commands={allCommands} onClose={closePalette} />
    </ShellContext.Provider>
  );
}
