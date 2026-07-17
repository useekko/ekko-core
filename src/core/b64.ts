// Native TC39 Uint8Array<->base64 (baseline: Chrome 133+, Firefox 133+, Node 22+).
// The TS lib doesn't type these yet, so declare them here. One place to swap in a
// polyfill if we ever need to support a pre-2025 engine (we don't — MV3 targets current Chrome).

declare global {
  interface Uint8Array {
    toBase64(opts?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }): string;
  }
  interface Uint8ArrayConstructor {
    fromBase64(
      s: string,
      opts?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' },
    ): Uint8Array;
  }
}

export function b64uEncode(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
}

export function b64uDecode(s: string): Uint8Array {
  return Uint8Array.fromBase64(s, { alphabet: 'base64url' });
}
