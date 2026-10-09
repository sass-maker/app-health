import { describe, expect, it, vi } from 'vitest';
import { advance, type JourneyState, type Outcome, type Transition } from '../src/incident.ts';
import { createDeliver, heartbeatLog, transitionLog } from '../src/emit.ts';
import { parseSpec } from '../src/spec.ts';

function replay(outcomes: Outcome[]): Array<Transition['kind'] | Transition['status'] | '-'> {
  let state: JourneyState | undefined;
  let id = 0;
  const seen: Array<Transition['kind'] | Transition['status'] | '-'> = [];
  outcomes.forEach((outcome, index) => {
    const next = advance(state, outcome, index, () => `incident-${++id}`);
    state = next.state;
    seen.push(next.transition ? `${next.transition.kind}` : '-');
  });
  return seen;
}

describe('advance', () => {
  it('opens a failing incident on the first failed complete response', () => {
    expect(replay(['ok', 'failed', 'failed', 'ok', 'ok'])).toEqual([
      '-',
      'opened',
      '-',
      '-',
      'recovered',
    ]);
  });

  it('needs two consecutive slow runs before opening a degraded incident', () => {
    expect(replay(['slow', 'ok', 'slow', 'slow', 'slow', 'ok', 'slow', 'ok', 'ok'])).toEqual([
      '-',
      '-',
      '-',
      'opened',
      '-',
      '-',
      '-',
      '-',
      'recovered',
    ]);
  });

  it('escalates a degraded incident to failing under the same id and never de-escalates', () => {
    let state: JourneyState | undefined;
    const ids: string[] = [];
    for (const [index, outcome] of (
      ['slow', 'slow', 'failed', 'slow', 'ok', 'ok'] as const
    ).entries()) {
      const next = advance(state, outcome, 100 + index, () => 'only-id');
      state = next.state;
      if (next.transition)
        ids.push(
          `${next.transition.kind}:${next.transition.status}:${next.transition.incident_id}:${next.transition.opened_at}`,
        );
    }
    expect(ids).toEqual([
      'opened:degraded:only-id:101',
      'escalated:failing:only-id:101',
      'recovered:healthy:only-id:101',
    ]);
    expect(state).toMatchObject({ status: 'healthy', bad_streak: 0 });
    expect(state?.incident_id).toBeUndefined();
  });

  it('recovers state that lost its incident id with a fresh id', () => {
    const next = advance(
      { status: 'failing', bad_streak: 0, good_streak: 1 },
      'ok',
      5,
      () => 'new',
    );
    expect(next.transition).toEqual({
      kind: 'recovered',
      status: 'healthy',
      incident_id: 'new',
      opened_at: 5,
    });
  });
});

const [journey] = parseSpec({
  schema_version: 1,
  journeys: [
    { project: 'anime-list', journey: 'anime-search', url: 'https://a.com/api', budget_ms: 2000 },
  ],
}).journeys;

describe('log events', () => {
  const context = { now: 1000, uuid: () => '00000000-0000-4000-8000-000000000001' };

  it('maps transitions to feed events with an allowlisted prop set', () => {
    const observation = {
      journey: journey!,
      outcome: 'failed' as const,
      failure: 'timeout' as const,
      phases: { total_ms: 8000, headers_ms: 200 },
    };
    const failed = transitionLog(
      { kind: 'opened', status: 'failing', incident_id: 'i-1', opened_at: 900 },
      observation,
      'india-home',
      context,
    );
    expect(failed).toMatchObject({ event: 'journey.failed', level: 'error' });
    expect(failed.props).toEqual({
      project: 'anime-list',
      journey: 'anime-search',
      incident_id: 'i-1',
      transition: 'opened',
      opened_at: 900,
      location: 'india-home',
      synthetic: true,
      probe_version: 1,
      outcome: 'failed',
      failure: 'timeout',
      budget_ms: 2000,
      total_ms: 8000,
      headers_ms: 200,
    });
    expect(JSON.stringify(failed)).not.toContain('https://');
    const slow = transitionLog(
      { kind: 'opened', status: 'degraded', incident_id: 'i-2', opened_at: 900 },
      { ...observation, outcome: 'slow', failure: undefined },
      'india-home',
      context,
    );
    expect(slow).toMatchObject({ event: 'journey.degraded', level: 'warn' });
    const recovered = transitionLog(
      { kind: 'recovered', status: 'healthy', incident_id: 'i-2', opened_at: 900 },
      { ...observation, outcome: 'ok', failure: undefined },
      'india-home',
      context,
    );
    expect(recovered).toMatchObject({ event: 'journey.recovered', level: 'info' });
    expect(recovered.title).toBe('anime-list anime-search recovered from india-home');
  });

  it('keeps heartbeats at debug level', () => {
    const log = heartbeatLog(
      'india-home',
      300,
      { journeys: 7, healthy: 7, degraded: 0, failing: 0, vantage_offline: false, pending_logs: 0 },
      context,
    );
    expect(log).toMatchObject({ event: 'probe.heartbeat', level: 'debug' });
    expect(log.props).toMatchObject({ location: 'india-home', interval_seconds: 300 });
  });
});

describe('createDeliver', () => {
  const log = heartbeatLog(
    'x',
    300,
    { journeys: 0, healthy: 0, degraded: 0, failing: 0, vantage_offline: false, pending_logs: 0 },
    { now: 1, uuid: () => 'l' },
  );

  it('posts one LogBatchV1 with the bearer key', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const deliver = createDeliver(
      { key: 'ahk_test', url: 'https://ingest.test/v1/logs', timeoutMs: 1000, fetch },
      () => 'batch',
    );
    await expect(deliver([log])).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ingest.test/v1/logs');
    expect(init.headers).toMatchObject({ authorization: 'Bearer ahk_test' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      batch_id: 'batch',
      schema_version: 'v1',
      environment: 'production',
      logs: [{ event: 'probe.heartbeat' }],
    });
  });

  it('resolves false on rejection or transport error and skips empty batches', async () => {
    const rejected = createDeliver(
      { key: 'k', url: 'u', timeoutMs: 1, fetch: async () => new Response(null, { status: 401 }) },
      () => 'b',
    );
    await expect(rejected([log])).resolves.toBe(false);
    const broken = createDeliver(
      { key: 'k', url: 'u', timeoutMs: 1, fetch: async () => Promise.reject(new Error('down')) },
      () => 'b',
    );
    await expect(broken([log])).resolves.toBe(false);
    await expect(broken([])).resolves.toBe(true);
  });
});
