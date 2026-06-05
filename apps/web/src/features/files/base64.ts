/**
 * Base64 <-> bytes/text helpers for the file browser. The node fs endpoints
 * carry file bytes as base64 (binary-safe over the JSON/exec channel); these
 * convert to/from the UTF-8 text the viewer/editor shows, chunked so large
 * files don't blow the call stack with `String.fromCharCode(...huge)`.
 */

/** Decode a base64 string to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode raw bytes to base64 (chunked to stay off the arg-count limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Encode a UTF-8 string to base64 (for editor save). */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Decode base64 file content to text, detecting binary. A NUL byte (or a high
 * ratio of replacement chars) means "not text" — the viewer shows a placeholder
 * instead of garbage.
 */
export function decodeFileContent(b64: string): { text: string; binary: boolean } {
  const bytes = base64ToBytes(b64);
  if (bytes.includes(0)) return { text: '', binary: true };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { text, binary: false };
}
