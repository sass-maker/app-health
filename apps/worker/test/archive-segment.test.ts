import { describe, expect, it, vi } from 'vitest';
import { persistArchiveSegment } from '../src/archive-segment.js';

describe('archive manifest rejects incomplete source facts', () => {
  it.each([
    [{ workspace: '', events: [{ timestamp: 1 }] }],
    [{ workspace: 'w'.repeat(101), events: [{ timestamp: 1 }] }],
    [{ workspace: 'w', events: [] }],
    [{ workspace: 'w', events: [{ timestamp: -1 }] }],
    [{ workspace: 'w', events: [{ timestamp: 1.5 }] }],
    [
      { workspace: 'w', events: [{ timestamp: 1 }] },
      { workspace: 'other', events: [{ timestamp: 2 }] },
    ],
  ])('retains staging instead of committing an invalid manifest: %j', async (...batches) => {
    const put = vi.fn();
    await expect(
      persistArchiveSegment(
        { put, get: vi.fn() },
        'browser-v2/test.jsonl.gz',
        batches.map((batch) => JSON.stringify(batch)).join('\n') + '\n',
        new ArrayBuffer(1),
      ),
    ).rejects.toThrow('Archive manifest');
    expect(put).not.toHaveBeenCalled();
  });
});
