import { describe, it, expect } from 'vitest';
import { stripTerminalReports } from './vt-reports';

describe('stripTerminalReports', () => {
  it('drops the DA2 reply that leaks as `0;276;0c`', () => {
    expect(stripTerminalReports('\x1b[>0;276;0c')).toBe('');
    // mixed with surrounding text → only the report is removed
    expect(stripTerminalReports('a\x1b[>0;276;0cb')).toBe('ab');
  });

  it('drops DA1 replies and XTVERSION replies', () => {
    expect(stripTerminalReports('\x1b[?1;2c')).toBe('');
    expect(stripTerminalReports('\x1bP>|xterm.js(5.0)\x1b\\')).toBe('');
  });

  it('keeps normal keystrokes and DSR cursor-position reports', () => {
    expect(stripTerminalReports('ls -la\r')).toBe('ls -la\r');
    expect(stripTerminalReports('\x1b[10;5R')).toBe('\x1b[10;5R'); // DSR — kept
    expect(stripTerminalReports('\x1b[A')).toBe('\x1b[A'); // arrow key — kept
  });
});
