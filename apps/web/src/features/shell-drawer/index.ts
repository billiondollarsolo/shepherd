/**
 * Bottom shell drawer feature (US-35).
 *
 * Public surface for the US-30 AppShell bottom (`Cmd+J`) slot. The shell mounts
 * {@link ShellDrawer} into its `drawer` region; open/close + the `Cmd+J` toggle
 * stay owned by KeyboardProvider, so this feature is presentational:
 *
 *   <AppShell
 *     drawer={<ShellDrawer sessionId={activeId} workingDir={cwd} onClose={...} />}
 *     drawerOpen={drawerOpen}
 *   />
 *
 * It reuses the terminal feature's shared PTY ws client (`usePtyWebSocket`) and
 * opens the *distinct* derived {@link shellSessionId} so the drawer and the
 * agent terminal share one bridge but never the same PTY.
 */
export { ShellDrawer } from './ShellDrawer';
export type { ShellDrawerProps } from './ShellDrawer';
export { shellSessionId, agentTerminalSessionId } from './types';
