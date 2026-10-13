import { afterEach, expect, it, vi } from 'vitest';
import { accountResourceClient } from '../src/lib/account-resource-client.js';

afterEach(() => vi.unstubAllGlobals());

it('reuses cached routes for one account and isolates another account and transport', () => {
  vi.stubGlobal('fetch', vi.fn());
  const first = accountResourceClient('first-owner');
  first.mutate('daily-engagement:2026-10-11', { date: '2026-10-11' });
  expect(accountResourceClient('first-owner')).toBe(first);
  expect(
    accountResourceClient('first-owner').entry('daily-engagement:2026-10-11').snapshot.data,
  ).toEqual({ date: '2026-10-11' });
  expect(
    accountResourceClient('second-owner').entry('daily-engagement:2026-10-11').snapshot.data,
  ).toBeUndefined();
  vi.stubGlobal('fetch', vi.fn());
  expect(accountResourceClient('first-owner')).not.toBe(first);
});

it('bounds the registry and retains the most recently visited account', () => {
  vi.stubGlobal('fetch', vi.fn());
  const first = accountResourceClient('owner-0');
  const second = accountResourceClient('owner-1');
  for (let index = 2; index < 8; index += 1) accountResourceClient(`owner-${index}`);
  expect(accountResourceClient('owner-0')).toBe(first);
  accountResourceClient('owner-8');
  expect(accountResourceClient('owner-0')).toBe(first);
  expect(accountResourceClient('owner-1')).not.toBe(second);
});
