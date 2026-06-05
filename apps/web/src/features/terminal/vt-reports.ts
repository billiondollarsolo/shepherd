/**
 * Strip terminal *report* sequences that xterm.js auto-generates when a program
 * queries it — Device Attributes (DA1 `ESC[?…c`, DA2 `ESC[>…c`) and XTVERSION
 * (`ESC P >| … ESC \`).
 *
 * Why: tmux probes the client's Device Attributes on every attach. Over Flock's
 * WebSocket↔PTY bridge the query reaches xterm, xterm generates the reply, and
 * the reply round-trips back — but by then tmux has often already handed the PTY
 * to the shell prompt, so the reply (e.g. `0;276;0c`, xterm's DA2/version) is
 * read as literal keyboard input and shows as garbage. A local terminal has no
 * round-trip, so it never races. tmux and well-behaved programs fall back to
 * defaults when they get no answer, so dropping these replies is safe and
 * removes the garbage.
 *
 * DSR cursor-position reports (`ESC[<row>;<col>R`) are deliberately KEPT —
 * readline and many TUIs depend on them and they don't end in `c`.
 */
const TERMINAL_REPORT_RE = /\x1b\[[?>][0-9;]*c|\x1bP>\|[\s\S]*?\x1b\\/g;

/** Remove DA/XTVERSION reply sequences from a chunk of xterm input. */
export function stripTerminalReports(data: string): string {
  return data.replace(TERMINAL_REPORT_RE, '');
}
