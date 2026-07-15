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
import { Keyboard } from 'lucide-react';
import { CommandPalette } from './CommandPalette';
import { SHORTCUTS, shortcutLabel, type Command } from './commands';
import { Kbd } from '../components/ui';
import { PRODUCT_NAME } from '../brand';

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
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function KeyboardProvider({
  children,
  commands: extraCommands = [],
}: KeyboardProviderProps): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
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

  // Built-in commands always available; shortcut labels come from the single
  // registry (commands.ts) so the palette hints and the `?` legend never drift.
  const builtins = useMemo<Command[]>(
    () => [
      {
        id: 'toggle-shell-drawer',
        title: 'Toggle shell drawer',
        hint: 'View',
        shortcut: shortcutLabel('shell-drawer'),
        run: () => setDrawerOpen((v) => !v),
      },
      {
        id: 'show-shortcuts',
        title: 'Keyboard shortcuts',
        hint: 'Help',
        shortcut: shortcutLabel('shortcuts'),
        icon: Keyboard,
        run: () => setCheatsheetOpen(true),
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
      // Escape always closes the topmost overlay (cheatsheet, then palette).
      if (e.key === 'Escape') {
        if (cheatsheetOpen) {
          setCheatsheetOpen(false);
          return;
        }
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
      }
      // Never hijack shortcuts while the user is typing.
      if (isEditableTarget(e.target)) return;

      // `?` (Shift+/) toggles the shortcut cheatsheet — no modifier required.
      if (e.key === '?') {
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
        return;
      }

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
  }, [paletteOpen, cheatsheetOpen]);

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
      <ShortcutCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </ShellContext.Provider>
  );
}

/**
 * The global `?` cheatsheet — a calm centered legend of every keyboard shortcut,
 * sourced from the single {@link SHORTCUTS} registry and rendered with the
 * canonical {@link Kbd} chip so the palette hints and this legend never drift.
 * Entrance motion reuses the palette recipe (collapsed under reduced-motion).
 */
function ShortcutCheatsheet({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div
      className="animate-scrim-in fixed inset-0 z-50 flex items-start justify-center bg-flock-scrim pt-[16vh] backdrop-blur-scrim"
      onMouseDown={onClose}
      data-testid="shortcut-cheatsheet-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="animate-palette-in w-[28rem] max-w-[90vw] overflow-hidden rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 shadow-overlay"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--flock-border)] px-4 py-3">
          <h2 className="font-display text-sm font-semibold text-flock-ink-primary">
            Keyboard shortcuts
          </h2>
          <p className="mt-0.5 text-2xs text-flock-ink-muted">
            {PRODUCT_NAME} · press Esc to close
          </p>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-1">
          {SHORTCUTS.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 px-4 py-2 text-sm text-flock-ink-primary"
            >
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {s.keys.map((k, i) => (
                  <Kbd key={`${s.id}-${i}`}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
