import { describe, it, expect } from 'vitest';
import { splitMessage, parseChunk, Reassembler } from '../src/core/chunk.js';

describe('chunking', () => {
  it('leaves a short token whole', () => {
    expect(splitMessage('RSN1M:short', 900, 'ab')).toEqual(['RSN1M:short']);
  });

  it('splits so every chunk fits the cap', () => {
    const token = 'RSN1H:' + 'x'.repeat(3000);
    const parts = splitMessage(token, 200, 'k7');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
  });

  it('reassembles regardless of arrival order', () => {
    const token = 'RSN1H:' + 'abcdef'.repeat(500);
    const parts = splitMessage(token, 137, 'zz'); // odd cap to exercise sizing
    const shuffled = [...parts].reverse();
    const r = new Reassembler();
    let out: string | null = null;
    for (const p of shuffled) out = r.add(p) ?? out;
    expect(out).toBe(token);
  });

  it('holds until every chunk has arrived', () => {
    const token = 'RSN1M:' + 'y'.repeat(1000);
    const parts = splitMessage(token, 150, 'q1');
    const r = new Reassembler();
    for (let i = 0; i < parts.length - 1; i++) expect(r.add(parts[i]!)).toBeNull();
    expect(r.add(parts[parts.length - 1]!)).toBe(token);
  });

  it('ignores non-chunk input', () => {
    expect(new Reassembler().add('RSN1M:notachunk')).toBeNull();
  });

  it('rejects oversized or impossible chunk groups before buffering them', () => {
    expect(parseChunk('RSN1C:abc:0/0:x')).toBeNull();
    expect(parseChunk('RSN1C:abc:256/256:x')).toBeNull();
    expect(parseChunk('RSN1C:abc:0/257:x')).toBeNull();
    expect(() => splitMessage('x'.repeat(10_000), 20, 'abc')).toThrow('message-too-long');
  });
});
