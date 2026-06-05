import { describe, it, expect } from 'vitest';
import { FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from './protocol.js';

/** Build a wire frame: 4-byte BE length prefix over (type byte + payload). */
function frame(type: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([type]), payload]);
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

describe('FrameDecoder (T25 size cap)', () => {
  it('decodes a normal frame and splits multiple frames in one chunk', () => {
    const dec = new FrameDecoder();
    const got: Array<{ type: number; payload: string }> = [];
    const f1 = frame(1, Buffer.from('hello'));
    const f2 = frame(2, Buffer.from('world'));
    dec.push(Buffer.concat([f1, f2]), (type, payload) =>
      got.push({ type, payload: payload.toString() }),
    );
    expect(got).toEqual([
      { type: 1, payload: 'hello' },
      { type: 2, payload: 'world' },
    ]);
  });

  it('reassembles a frame split across chunks', () => {
    const dec = new FrameDecoder();
    const f = frame(1, Buffer.from('abcdef'));
    const got: string[] = [];
    dec.push(f.subarray(0, 5), (_t, p) => got.push(p.toString()));
    expect(got).toHaveLength(0); // incomplete
    dec.push(f.subarray(5), (_t, p) => got.push(p.toString()));
    expect(got).toEqual(['abcdef']);
  });

  it('throws FrameTooLargeError on an over-cap length prefix', () => {
    const dec = new FrameDecoder();
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(MAX_FRAME_BYTES + 1, 0); // bogus huge length
    expect(() => dec.push(hdr, () => {})).toThrow(FrameTooLargeError);
  });
});
