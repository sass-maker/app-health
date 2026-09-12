import { expect, it, vi } from 'vitest';
import { legacyLogAlertsAllowed } from '../src/log-alert-scope.js';
import { deliverLogAlerts } from '../src/log-alerts.js';

it('keeps deployment webhooks out of account-owned projects and fails closed on lookup failure', async () => {
  const statement = {
    bind: vi.fn(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };
  statement.bind.mockReturnValue(statement);
  const db = { prepare: vi.fn(() => statement), batch: vi.fn() };
  statement.first
    .mockResolvedValueOnce({ name: 'workspace_apps' })
    .mockResolvedValueOnce({ workspace_id: 'other-owner' });
  expect(await legacyLogAlertsAllowed(db, 'private-app')).toBe(false);
  expect(statement.bind).toHaveBeenCalledWith('private-app');
  statement.first.mockResolvedValueOnce({ name: 'workspace_apps' }).mockResolvedValueOnce(null);
  expect(await legacyLogAlertsAllowed(db, 'legacy-app')).toBe(true);
  statement.first.mockResolvedValueOnce(null);
  expect(await legacyLogAlertsAllowed(db, 'legacy-app')).toBe(true);
  statement.first.mockRejectedValueOnce(new Error('lookup unavailable'));
  expect(await legacyLogAlertsAllowed(db, 'unknown-app')).toBe(false);
  expect(await legacyLogAlertsAllowed(undefined, 'local-app')).toBe(true);
});

it('bounds external alert delivery and does not log webhook credentials on failure', async () => {
  let now = 1_725_000_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const log = {
    log_id: crypto.randomUUID(),
    timestamp: now,
    event: 'test',
    level: 'info' as const,
    props: {},
  };
  const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    now += 10_001;
    return new Response('ok');
  });
  const options = {
    appName: 'test',
    environmentName: 'prod',
    webhookUrl: 'https://hooks.example/private-token',
    minLevel: 'info' as const,
  };
  try {
    expect(await deliverLogAlerts([log, log], { ...options, fetch: send })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    await deliverLogAlerts([log], {
      ...options,
      fetch: async () => {
        throw new Error(options.webhookUrl);
      },
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-token');
  } finally {
    clock.mockRestore();
    error.mockRestore();
  }
});
