/**
 * The Flock paddock app shell (US-30).
 *
 * Public surface for the Codex-style three-region layout, the global keyboard
 * model, and the command palette. Later UI stories import these and mount their
 * content into the shell's stable region slots.
 */
export { AppShell } from './AppShell';
export type { AppShellProps } from './AppShell';
export { KeyboardProvider, useShell } from './KeyboardProvider';
export type { KeyboardProviderProps, ShellContextValue } from './KeyboardProvider';
export { CommandPalette } from './CommandPalette';
export type { CommandPaletteProps } from './CommandPalette';
export { Paddock } from './Paddock';
export { filterCommands } from './commands';
export type { Command } from './commands';
