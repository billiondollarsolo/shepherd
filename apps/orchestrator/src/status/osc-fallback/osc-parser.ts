/**
 * US-19 — OSC / BEL status parser.
 *
 * A streaming parser that scans a raw PTY byte stream for the terminal control
 * sequences that generic agents (Codex, OpenCode, plain shells with terminal
 * integration) use to signal attention / completion, and maps them onto the
 * canonical {@link FallbackStatus} subset.
 *
 * Mapping (see spec §7.1 "Universal fallback"):
 *   - `OSC 9 ; <text> BEL`                      -> awaiting_input   (osc9-notify)
 *   - `OSC 777 ; notify ; <title> ; <body> BEL` -> awaiting_input   (osc777-notify)
 *   - bare `BEL`                                -> awaiting_input   (bel)
 *   - `OSC 9 ; 4 ; ...` (ConEmu progress)       -> ignored (NOT a notification)
 *   - `OSC 133 ; D` (command finished)          -> done             (osc133-finished)
 *   - `OSC 133 ; A|B|C`                         -> ignored
 *
 * Design notes / requirements from the spec:
 *   - Must be a *streaming* parser: an OSC sequence may be split across multiple
 *     PTY reads (chunk boundaries). State is carried between {@link push} calls.
 *   - Accepts both terminators: BEL (0x07) and ST (ESC `\`, i.e. 0x1b 0x5c).
 *   - Operates on raw bytes; never throws on arbitrary binary input.
 */
import type { StatusSink, StatusSignal } from './types.js';

const BEL = 0x07; // \x07
const ESC = 0x1b; // \x1b
const OSC = 0x5d; // ']' — introduces an Operating System Command after ESC
const BACKSLASH = 0x5c; // '\' — second byte of the ST (ESC \) terminator

/**
 * Hard cap on how many bytes we will accumulate for a single, never-terminated
 * OSC payload before giving up and dropping back to the ground state. Protects
 * against unbounded memory growth from a misbehaving / binary stream.
 */
const MAX_OSC_PAYLOAD = 8 * 1024;

type State = 'ground' | 'esc' | 'osc' | 'osc-esc';

export class OscBelParser {
  private state: State = 'ground';
  /** Accumulated OSC payload bytes (between the introducer and the terminator). */
  private osc: number[] = [];
  private readonly sink: StatusSink;

  constructor(sink: StatusSink) {
    this.sink = sink;
  }

  /**
   * Feed the next chunk of raw PTY bytes. Emits zero or more status signals
   * synchronously via the sink supplied to the constructor.
   */
  push(chunk: Buffer | Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      switch (this.state) {
        case 'ground':
          if (b === ESC) {
            this.state = 'esc';
          } else if (b === BEL) {
            // Standalone BEL — attention.
            this.emit({ status: 'awaiting_input', reason: 'bel' });
          }
          // any other byte is ordinary output: ignore for parsing purposes
          break;

        case 'esc':
          if (b === OSC) {
            this.state = 'osc';
            this.osc = [];
          } else if (b === ESC) {
            // ESC ESC — stay armed for the next byte.
            this.state = 'esc';
          } else {
            // ESC followed by anything else (CSI '[', SGR, cursor moves, ...):
            // not an OSC, return to ground without emitting.
            this.state = 'ground';
          }
          break;

        case 'osc':
          if (b === BEL) {
            this.completeOsc();
          } else if (b === ESC) {
            // possible start of an ST (ESC \) terminator
            this.state = 'osc-esc';
          } else {
            this.osc.push(b);
            if (this.osc.length > MAX_OSC_PAYLOAD) {
              // Runaway / never-terminated OSC: bail out, drop the payload.
              this.reset();
            }
          }
          break;

        case 'osc-esc':
          if (b === BACKSLASH) {
            // ST terminator completed.
            this.completeOsc();
          } else {
            // The ESC did not begin an ST. It terminated/aborted the OSC.
            // Re-process the current byte from ground so we don't swallow a new
            // sequence (e.g. ESC ] ... ESC ] ...).
            this.state = 'ground';
            i--;
          }
          break;

        /* c8 ignore next 2 -- exhaustive guard */
        default:
          this.state = 'ground';
      }
    }
  }

  /** Finish the current OSC payload, classify it, and return to ground. */
  private completeOsc(): void {
    const payload = Buffer.from(this.osc).toString('utf8');
    this.reset();
    const signal = classifyOsc(payload);
    if (signal) this.emit(signal);
  }

  private reset(): void {
    this.state = 'ground';
    this.osc = [];
  }

  private emit(signal: StatusSignal): void {
    this.sink(signal);
  }
}

/**
 * Classify an OSC payload (the bytes between the `ESC ]` introducer and the
 * terminator) into a status signal, or `null` if it carries no status meaning.
 */
function classifyOsc(payload: string): StatusSignal | null {
  // Split on ';' — OSC parameters are semicolon-delimited.
  const semi = payload.indexOf(';');
  const code = semi === -1 ? payload : payload.slice(0, semi);
  const rest = semi === -1 ? '' : payload.slice(semi + 1);

  switch (code) {
    case '9': {
      // ConEmu progress: `OSC 9 ; 4 ; <state> ; <progress>` — NOT a notification.
      const firstParam = rest.split(';', 1)[0];
      if (firstParam === '4') return null;
      return { status: 'awaiting_input', reason: 'osc9-notify', text: rest };
    }

    case '777': {
      // `OSC 777 ; notify ; <title> ; <body>` — only `notify` is a notification.
      const params = rest.split(';');
      if (params[0] !== 'notify') return null;
      const body = params.slice(2).join(';');
      return { status: 'awaiting_input', reason: 'osc777-notify', text: body };
    }

    case '133': {
      // Shell integration markers. Only `D` (command finished) is a status hint
      // and maps to `done` per the spec §7.1 fallback table.
      const marker = rest.split(';', 1)[0];
      if (marker === 'D') return { status: 'done', reason: 'osc133-finished' };
      return null;
    }

    default:
      return null;
  }
}
