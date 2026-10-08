import { describe, expect, it, vi } from 'vitest';
import {
  BOT_COUNTER_HEARTBEAT_INDEX,
  botCountersCoverDay,
  writeBotCounter,
  writeBotCounterHeartbeat,
} from '../src/browser-bot-counters.js';

const scope = { app_id: 'app-one', environment_id: 'env-one' };
const event = (type: 'pageview' | 'event', referrer = '') => ({
  event_id: crypto.randomUUID(),
  timestamp: 1,
  type,
  path: '/private/path',
  referrer,
});

describe('bot counters', () => {
  it('writes one identity-free point per non-empty batch', () => {
    const writeDataPoint = vi.fn();
    writeBotCounter(
      { writeDataPoint },
      scope,
      { events: [event('pageview', 'https://bing.com/'), event('event'), event('pageview')] },
      'user_agent',
      42,
    );
    writeBotCounter({ writeDataPoint }, scope, { events: [] }, 'verified', 42);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['bot:app-one'],
      blobs: ['app-one', 'env-one', 'bot_batch', 'https://bing.com/', 'user_agent'],
      doubles: [2, 42, 1],
    });
  });

  it('prefers attribution source, bounds it, and skips oversized indexes', () => {
    const writeDataPoint = vi.fn();
    const attribution = {
      source: 'x'.repeat(300),
      medium: '',
      campaign: '',
      content: '',
      term: '',
      entry_path: '/',
    };
    writeBotCounter(
      { writeDataPoint },
      scope,
      { events: [event('pageview')], attribution },
      'verified',
      1,
    );
    expect(writeDataPoint.mock.calls[0]![0].blobs[3]).toHaveLength(100);
    writeBotCounter(
      { writeDataPoint },
      { ...scope, app_id: 'a'.repeat(100) },
      { events: [event('pageview')] },
      'verified',
      1,
    );
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('never throws when the dataset write or binding fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = {
      writeDataPoint: () => {
        throw new Error('AE down');
      },
    };
    expect(() =>
      writeBotCounter(failing, scope, { events: [event('pageview')] }, 'verified', 1),
    ).not.toThrow();
    expect(() => writeBotCounterHeartbeat(failing, 1)).not.toThrow();
    expect(() =>
      writeBotCounter(undefined, scope, { events: [event('pageview')] }, 'verified', 1),
    ).not.toThrow();
    expect(() => writeBotCounterHeartbeat(undefined, 1)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('writes an hourly heartbeat outside workspace indexes', () => {
    const writeDataPoint = vi.fn();
    writeBotCounterHeartbeat({ writeDataPoint }, 99);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: [BOT_COUNTER_HEARTBEAT_INDEX],
      blobs: ['heartbeat'],
      doubles: [1, 99],
    });
  });

  it('requires heartbeats spanning the whole day', () => {
    const from = 10_000_000;
    const to = from + 86_400_000;
    expect(
      botCountersCoverDay([{ first_seen: from - 1, last_seen: to, beats: 26 }], from, to),
    ).toBe(true);
    expect(
      botCountersCoverDay([{ first_seen: from + 1, last_seen: to, beats: 26 }], from, to),
    ).toBe(false);
    expect(
      botCountersCoverDay([{ first_seen: from, last_seen: to - 1, beats: 26 }], from, to),
    ).toBe(false);
    expect(botCountersCoverDay([{ first_seen: from, last_seen: to, beats: 10 }], from, to)).toBe(
      false,
    );
    expect(botCountersCoverDay([], from, to)).toBe(false);
    expect(botCountersCoverDay([{ first_seen: 'x', last_seen: to, beats: 26 }], from, to)).toBe(
      false,
    );
  });
});
