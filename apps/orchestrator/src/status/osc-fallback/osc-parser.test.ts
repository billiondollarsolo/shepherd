import { describe, expect, it, vi } from 'vitest';
import { OscBelParser } from './osc-parser.js';
import type { StatusSignal } from './types.js';

const BEL = '\x07';
const ESC = '\x1b';
const ST = `${ESC}\\`; // String Terminator

/** Collect every signal emitted while feeding the given chunks to a fresh parser. */
function feed(...chunks: string[]): StatusSignal[] {
  const out: StatusSignal[] = [];
  const parser = new OscBelParser((s) => out.push(s));
  for (const c of chunks) parser.push(Buffer.from(c, 'utf8'));
  return out;
}

describe('OscBelParser (US-20: OSC 9/777 + BEL)', () => {
  describe('OSC 9 notification -> awaiting_input', () => {
    it('maps `OSC 9 ; <text> BEL` to awaiting_input', () => {
      const signals = feed(`${ESC}]9;Build finished, your input is needed${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        status: 'awaiting_input',
        reason: 'osc9-notify',
        text: 'Build finished, your input is needed',
      });
    });

    it('accepts the ST (ESC \\) terminator as well as BEL', () => {
      const signals = feed(`${ESC}]9;needs you${ST}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ status: 'awaiting_input', reason: 'osc9-notify' });
    });
  });

  describe('OSC 9 ; 4 ConEmu progress is NOT a notification', () => {
    it('ignores `OSC 9 ; 4 ; <state> ; <progress> BEL`', () => {
      const signals = feed(`${ESC}]9;4;1;42${BEL}`);
      expect(signals).toEqual([]);
    });

    it('still treats `OSC 9 ; 40` (not the `4` param) as a notification', () => {
      const signals = feed(`${ESC}]9;40 percent done${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.status).toBe('awaiting_input');
    });
  });

  describe('OSC 777 notification -> awaiting_input', () => {
    it('maps `OSC 777 ; notify ; <title> ; <body> BEL` to awaiting_input', () => {
      const signals = feed(`${ESC}]777;notify;Codex;Please confirm the plan${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        status: 'awaiting_input',
        reason: 'osc777-notify',
        text: 'Please confirm the plan',
      });
    });

    it('ignores OSC 777 sub-commands other than notify', () => {
      const signals = feed(`${ESC}]777;precmd${BEL}`);
      expect(signals).toEqual([]);
    });
  });

  describe('standalone BEL -> awaiting_input', () => {
    it('maps a bare BEL to awaiting_input', () => {
      const signals = feed(`some output${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ status: 'awaiting_input', reason: 'bel' });
    });

    it('does NOT emit a standalone bel for the BEL that terminates an OSC', () => {
      const signals = feed(`${ESC}]9;hi${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.reason).toBe('osc9-notify');
    });
  });

  describe('OSC 133 shell integration', () => {
    it('treats `OSC 133 ; D` (command finished) as done', () => {
      const signals = feed(`${ESC}]133;D${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ status: 'done', reason: 'osc133-finished' });
    });

    it('ignores other OSC 133 markers (A/B/C)', () => {
      const signals = feed(
        `${ESC}]133;A${BEL}`,
        `${ESC}]133;B${BEL}`,
        `${ESC}]133;C${BEL}`,
      );
      expect(signals).toEqual([]);
    });
  });

  describe('streaming across chunk boundaries', () => {
    it('reassembles an OSC split mid-sequence over several pushes', () => {
      const signals = feed(`${ESC}]9;`, 'split ', 'across ', `chunks${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        status: 'awaiting_input',
        reason: 'osc9-notify',
        text: 'split across chunks',
      });
    });

    it('handles the ESC byte arriving alone, then `]9;...BEL` next chunk', () => {
      const signals = feed(ESC, `]9;late${BEL}`);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.reason).toBe('osc9-notify');
    });

    it('handles a two-byte ST terminator split across the boundary', () => {
      const signals = feed(`${ESC}]9;halves${ESC}`, '\\');
      expect(signals).toHaveLength(1);
      expect(signals[0]?.reason).toBe('osc9-notify');
    });

    it('does not lose a standalone BEL that arrives in its own chunk', () => {
      const signals = feed('output', BEL);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.reason).toBe('bel');
    });
  });

  describe('robustness', () => {
    it('ignores unrelated CSI/SGR escape sequences', () => {
      const signals = feed(`${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[H`);
      expect(signals).toEqual([]);
    });

    it('does not emit when there is no terminator yet (incomplete OSC)', () => {
      const signals = feed(`${ESC}]9;still typing`);
      expect(signals).toEqual([]);
    });

    it('feeds raw bytes (Buffer) and never throws on arbitrary binary', () => {
      const out: StatusSignal[] = [];
      const parser = new OscBelParser((s) => out.push(s));
      expect(() =>
        parser.push(Buffer.from([0x00, 0xff, 0x1b, 0x5d, 0x39, 0x3b, 0x41, 0x07])),
      ).not.toThrow();
      // ESC ] 9 ; A BEL  -> one osc9 notify
      expect(out).toHaveLength(1);
      expect(out[0]?.reason).toBe('osc9-notify');
    });

    it('emits multiple signals from one chunk', () => {
      const signals = feed(`${ESC}]9;one${BEL}${ESC}]9;two${BEL}`);
      expect(signals).toHaveLength(2);
      expect(signals.map((s) => s.text)).toEqual(['one', 'two']);
    });

    it('caps a runaway (never-terminated) OSC payload instead of buffering forever', () => {
      const out: StatusSignal[] = [];
      const parser = new OscBelParser((s) => out.push(s));
      parser.push(Buffer.from(`${ESC}]9;${'x'.repeat(20_000)}`, 'utf8'));
      expect(out).toEqual([]);
      // A subsequent well-formed sequence is still parsed correctly.
      parser.push(Buffer.from(`${ESC}]9;recovered${BEL}`, 'utf8'));
      expect(out).toHaveLength(1);
      expect(out[0]?.text).toBe('recovered');
    });

    it('invokes the sink synchronously for each completed sequence', () => {
      const sink = vi.fn();
      const parser = new OscBelParser(sink);
      parser.push(Buffer.from(`${ESC}]9;x${BEL}`, 'utf8'));
      expect(sink).toHaveBeenCalledTimes(1);
    });
  });
});
