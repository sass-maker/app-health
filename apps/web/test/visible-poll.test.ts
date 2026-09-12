import { afterEach, expect, it, vi } from 'vitest';
import { pollWhileVisible } from '../src/lib/visible-poll.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('stops background reads, refreshes on return, and removes all work on teardown', () => {
  vi.useFakeTimers();
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const read = vi.fn();
  const stop = pollWhileVisible(read, 10000);
  vi.advanceTimersByTime(10000);
  expect(read).toHaveBeenCalledTimes(1);
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(300000);
  expect(read).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10000);
  expect(read).toHaveBeenCalledTimes(3);
  stop();
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(10000);
  expect(read).toHaveBeenCalledTimes(3);
});
