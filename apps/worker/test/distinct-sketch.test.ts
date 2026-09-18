import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DistinctSketchAccumulator } from '../src/distinct-sketch.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe('mergeable distinct sketches', () => {
  it('is exact while cardinality remains sparse', () => {
    const sketch = new DistinctSketchAccumulator();
    for (const value of ['a', 'b', 'a', 'c']) sketch.addDigest(digest(value));
    expect(sketch.snapshot().encoding).toBe('sparse');
    expect(sketch.estimate()).toBe(3);
  });

  it('merges overlapping sparse buckets without summing daily uniques', () => {
    const first = new DistinctSketchAccumulator();
    const second = new DistinctSketchAccumulator();
    for (const value of ['visitor-a', 'visitor-b']) first.addDigest(digest(value));
    for (const value of ['visitor-b', 'visitor-c']) second.addDigest(digest(value));
    first.merge(second.snapshot());
    expect(first.estimate()).toBe(3);
  });

  it('keeps the complete digest while sparse instead of collapsing a shared prefix', () => {
    const sketch = new DistinctSketchAccumulator();
    sketch.addDigest(`${'a'.repeat(16)}${'0'.repeat(48)}`);
    sketch.addDigest(`${'a'.repeat(16)}${'f'.repeat(48)}`);
    expect(sketch.estimate()).toBe(2);
  });

  it('converts to dense registers and keeps estimates within a bounded error', () => {
    const first = new DistinctSketchAccumulator();
    const second = new DistinctSketchAccumulator();
    for (let index = 0; index < 10_000; index += 1) {
      const target = index < 5_000 ? first : second;
      target.addDigest(digest(`visitor-${index}`));
    }
    first.merge(second.snapshot());
    expect(first.snapshot().encoding).toBe('dense');
    expect(first.estimate()).toBeGreaterThan(9_500);
    expect(first.estimate()).toBeLessThan(10_500);
  });

  it('rejects malformed digests and incompatible precision', () => {
    expect(() => new DistinctSketchAccumulator().addDigest('visitor')).toThrow('SHA-256');
    expect(() =>
      new DistinctSketchAccumulator(12).merge(new DistinctSketchAccumulator(13).snapshot()),
    ).toThrow('different precision');
  });

  it('rejects dense sketches with impossible register ranks', () => {
    const dense = new DistinctSketchAccumulator(10);
    for (let index = 0; index <= 256; index += 1) dense.addDigest(digest(`dense-${index}`));
    const snapshot = dense.snapshot();
    const bytes = atob(snapshot.registers);
    const corrupted = btoa(String.fromCharCode(255) + bytes.slice(1));
    expect(
      () =>
        new DistinctSketchAccumulator(10, {
          ...snapshot,
          registers: corrupted,
        }),
    ).toThrow('register');
  });
});
