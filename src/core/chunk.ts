// Transport chunking. A single DM has a hard length cap (Instagram: 1000 chars), but a
// handshake token is ~3100 chars. Split oversized tokens into EKK1C:<id>:<i>/<n>:<part>
// and reassemble before decrypt. id is short base36, caller-supplied for determinism.
import { PREFIX } from './wire.js';

const CHUNK_RE = /^(?:EKK1C|RSN1C):([0-9a-z]+):(\d+)\/(\d+):([\s\S]*)$/;
// A receiver buffers chunks from untrusted page text. 256 × 900-byte Instagram messages
// is already far beyond a normal DM while keeping an abandoned group bounded.
const MAX_CHUNKS = 256;

const headerLen = (id: string, i: number, n: number) => `${PREFIX.chunk}${id}:${i}/${n}:`.length;

// Random group id so chunk streams from different messages never collide in a receiver's
// long-lived Reassembler. Shared by the content script and the popup's manual encrypt.
export function randomChunkId(): string {
  // Fixed 2 chars/byte so the concatenation is injective (full 32-bit space, [0-9a-z]).
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, '0')).join('');
}

export function splitMessage(token: string, maxLen: number, id: string): string[] {
  if (token.length <= maxLen) return [token];
  // n depends on per-chunk payload size, which depends on the digit-width of n. Solve by
  // iterating up from an estimate until it's self-consistent (converges in 1-2 steps).
  let n = Math.ceil(token.length / (maxLen - headerLen(id, 0, 0)));
  if (n > MAX_CHUNKS) throw new Error('message-too-long');
  for (;;) {
    const avail = maxLen - headerLen(id, n, n); // n is an upper bound on index digit-width
    if (avail <= 0) throw new Error('maxLen too small to chunk');
    const need = Math.ceil(token.length / avail);
    if (need > MAX_CHUNKS) throw new Error('message-too-long');
    if (need <= n) break;
    n = need;
  }
  const avail = maxLen - headerLen(id, n, n);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`${PREFIX.chunk}${id}:${i}/${n}:` + token.slice(i * avail, (i + 1) * avail));
  }
  return parts;
}

export function parseChunk(s: string): { id: string; index: number; total: number; part: string } | null {
  const m = s.match(CHUNK_RE);
  if (!m) return null;
  const index = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || total > MAX_CHUNKS || index >= total)
    return null;
  return { id: m[1]!, index, total, part: m[4]! };
}

// Buffers chunks (arriving in any order, across renders) until a group is whole.
export class Reassembler {
  private buf = new Map<string, Map<number, string>>();

  add(s: string): string | null {
    const c = parseChunk(s);
    if (!c) return null;
    let group = this.buf.get(c.id);
    if (!group) {
      // ponytail: FIFO cap keeps an abandoned-groups leak bounded; LRU if it ever matters
      if (this.buf.size >= 64) {
        const oldest = this.buf.keys().next().value;
        if (oldest !== undefined) this.buf.delete(oldest);
      }
      group = new Map();
      this.buf.set(c.id, group);
    }
    group.set(c.index, c.part);
    if (group.size < c.total) return null;
    let out = '';
    for (let i = 0; i < c.total; i++) {
      const p = group.get(i);
      if (p === undefined) return null; // gap — wait for more
      out += p;
    }
    this.buf.delete(c.id);
    return out;
  }
}
