import { describe, expect, it } from 'vitest';
import { supersededArchiveSources } from '../src/archive-retention.js';

const proof = {
  schema_version: 1 as const,
  source_key: 'browser-v2/2026/08/01/source.jsonl.gz',
  source_sha256: 'a'.repeat(64),
  source_rows: 12,
  source_events: 30,
  replacement_key: 'analytics/v1/day=2026-08-01/compacted.parquet',
  replacement_sha256: 'b'.repeat(64),
  replacement_rows: 12,
  replacement_events: 30,
  verified_at: Date.UTC(2026, 8, 13),
};

describe('browser archive retention guard', () => {
  it('never treats age alone or an unfinished replacement as deletion evidence', () => {
    expect(
      supersededArchiveSources([
        { ...proof, state: 'pending' },
        { ...proof, state: 'written' },
        { ...proof, state: 'verified', replacement_events: 29 },
      ]),
    ).toEqual([]);
  });

  it('does not authorize deletion from fabricated equal-count replacement proof', () => {
    expect(
      supersededArchiveSources([
        { ...proof, state: 'verified' },
        { ...proof, state: 'verified', source_key: proof.replacement_key },
        { ...proof, state: 'verified', source_rows: 13 },
      ]),
    ).toEqual([]);
  });

  it('fails closed for malformed proof records', () => {
    expect(
      supersededArchiveSources([{ ...proof, state: 'verified', source_sha256: 'not-a-digest' }]),
    ).toEqual([]);
  });
});
