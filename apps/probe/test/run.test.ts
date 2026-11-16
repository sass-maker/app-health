import { probeDefinitionRevision } from '../../../packages/contracts/src/probe-revision.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, readState, writeState } from '../src/cli.ts';
import type { HttpResult, Measure } from '../src/measure.ts';
import type { ProbeLog } from '../src/emit.ts';
import { emptyState, MAX_PENDING_LOGS, runProbes, type ProbeState } from '../src/run.ts';
import { parseSpec } from '../src/spec.ts';

const json = (body: unknown, total = 100): HttpResult => ({
  status: 200,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)),
  phases: { total_ms: total, headers_ms: total / 2 },
});
const html = (total = 100): HttpResult => ({
  status: 200,
  contentType: 'text/html',
  body: Buffer.from('<div id="root"></div><script src="/assets/app.js"></script>'),
  phases: { total_ms: total },
});

const spec = parseSpec({
  schema_version: 1,
  journeys: [
    {
      project: 'anime-list',
      journey: 'home',
      url: 'https://anime.test/',
      budget_ms: 2000,
      expect: { body_includes: ['id="root"'], first_party_asset: true },
    },
    {
      project: 'anime-list',
      journey: 'search',
      url: 'https://anime.test/api/search',
      method: 'POST',
      body: { filters: [] },
      budget_ms: 2000,
      warm_check: true,
      expect: { json: [{ path: 'filteredList', min_items: 1 }] },
    },
  ],
});

function harness(responses: Record<string, HttpResult | HttpResult[]>, deliverOk = true) {
  const sent: ProbeLog[][] = [];
  let id = 0;
  const measure: Measure = async (request) => {
    const entry = responses[request.url];
    if (!entry) return { failure: 'dns', phases: { total_ms: 1 } };
    return Array.isArray(entry)
      ? (entry.shift() ?? { failure: 'network', phases: { total_ms: 1 } })
      : entry;
  };
  return {
    sent,
    deps: {
      measure,
      deliver: async (logs: ProbeLog[]) => (sent.push(logs), deliverOk),
      now: () => 1_000,
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    },
  };
}

const options = { location: 'india-home', intervalSeconds: 300, userAgent: 'test' };
const healthy = {
  'https://anime.test/': html(),
  'https://anime.test/assets/app.js': {
    status: 200,
    body: Buffer.from('x'),
    phases: { total_ms: 50 },
  },
  'https://anime.test/api/search': json({ filteredList: [1] }),
};

it('keeps a completed outage while a later journey is skipped by the run budget', async () => {
  const { deps, sent } = harness({
    'https://anime.test/': { ...html(), status: 503 },
    'https://anime.test/api/search': { failure: 'run_deadline', phases: { total_ms: 0 } },
  });
  const { state, summary } = await runProbes(spec, emptyState(), options, deps);
  expect(summary.journeys.map((row) => row.outcome)).toEqual(['failed', 'not_completed']);
  expect(Object.keys(state.journeys)).toEqual(['anime-list/home']);
  expect(
    sent[0]?.filter((log) => log.event === 'journey.failed').map((log) => log.props.journey),
  ).toEqual(['home']);
  expect(
    sent[0]?.find((log) => log.event === 'probe.result' && log.props.journey === 'search')?.props,
  ).toMatchObject({ status: null, vantage_offline: true, failure: 'run_deadline' });
  expect(sent[0]?.at(-1)?.props).toMatchObject({ healthy: 0, failing: 1, journeys: 2 });
});

it.each(['main', 'asset', 'warm'] as const)(
  'preserves incident recovery state when the run deadline interrupts %s',
  async (phase) => {
    const journey = spec.journeys[phase === 'warm' ? 1 : 0]!;
    const single = { ...spec, journeys: [journey] };
    const failing = harness({ [journey.url]: { ...json({}), status: 503 } });
    const opened = await runProbes(single, emptyState(), options, failing.deps);
    const good = harness({ ...healthy });
    const recovering = await runProbes(single, opened.state, options, good.deps);
    const deadline: HttpResult = { failure: 'run_deadline', phases: { total_ms: 0 } };
    const responses: Record<string, HttpResult | HttpResult[]> = { ...healthy };
    if (phase === 'main') responses[journey.url] = deadline;
    if (phase === 'asset') responses['https://anime.test/assets/app.js'] = deadline;
    if (phase === 'warm') responses[journey.url] = [json({ filteredList: [1] }), deadline];
    const skipped = harness(responses);
    const result = await runProbes(single, recovering.state, options, skipped.deps);
    expect(result.state.journeys).toEqual(recovering.state.journeys);
    expect(result.summary.journeys[0]).toMatchObject({
      outcome: 'not_completed',
      failure: 'run_deadline',
      status: null,
    });
    expect(skipped.sent[0]?.filter((log) => log.event.startsWith('journey.'))).toEqual([]);
    expect(skipped.sent[0]?.find((log) => log.event === 'probe.result')?.props).toMatchObject({
      status: null,
      vantage_offline: true,
      failure: 'run_deadline',
    });
  },
);

describe('runProbes', () => {
  it('records each healthy check and a heartbeat', async () => {
    const { deps, sent } = harness(healthy);
    const { state, summary } = await runProbes(spec, emptyState(), options, deps);
    expect(summary.journeys.map((item) => item.outcome)).toEqual(['ok', 'ok']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((log) => log.event)).toEqual([
      'probe.result',
      'probe.result',
      'probe.heartbeat',
    ]);
    expect(sent[0]?.at(-1)?.props).toMatchObject({ healthy: 2, failing: 0, journeys: 2 });
    expect(sent[0]?.[0]?.props).toMatchObject({
      project: 'anime-list',
      journey: 'home',
      status: 'healthy',
      interval_seconds: 300,
    });
    expect(state.pending).toEqual([]);
  });

  it('delivers results and state for an accepted budget above the default timeout cap', async () => {
    const definition = {
      project: 'anime-list',
      journey: 'long-budget',
      url: 'https://anime.test/',
      budget_ms: 40000,
    };
    const parsed = parseSpec({ schema_version: 1, journeys: [definition] });
    expect(parsed.journeys[0]?.timeout_ms).toBe(30000);
    const { deps, sent } = harness({ 'https://anime.test/': json({ ok: true }) });
    const measure = vi.fn(deps.measure);
    const { summary, state } = await runProbes(parsed, emptyState(), options, { ...deps, measure });
    expect(measure.mock.calls[0]?.[0].timeoutMs).toBe(30000);
    expect(summary.journeys[0]).toMatchObject({ outcome: 'ok', status: 'healthy' });
    const revision = await probeDefinitionRevision(definition);
    expect(sent[0]?.find((log) => log.event === 'probe.result')?.props).toMatchObject({
      project: 'anime-list',
      journey: 'long-budget',
      status: 'healthy',
      revision,
    });
    expect(state.revisions?.['anime-list/long-budget']).toBe(revision);
    expect(state.pending).toEqual([]);
  });

  it('opens an incident for a semantic failure and a missing asset', async () => {
    const { deps, sent } = harness({
      'https://anime.test/': { ...html(), body: Buffer.from('<div id="root"></div>') },
      'https://anime.test/api/search': json({ filteredList: [] }),
    });
    const { summary } = await runProbes(spec, emptyState(), options, deps);
    expect(summary.journeys).toMatchObject([
      { outcome: 'failed', failure: 'asset', detail: 'no first-party asset', status: 'failing' },
      { outcome: 'failed', failure: 'semantic', status: 'failing' },
    ]);
    expect(sent[0]?.map((log) => log.event)).toEqual([
      'journey.failed',
      'journey.failed',
      'probe.result',
      'probe.result',
      'probe.heartbeat',
    ]);
  });

  it('fails a page whose required asset does not load', async () => {
    const { deps } = harness({
      ...healthy,
      'https://anime.test/assets/app.js': {
        status: 404,
        body: Buffer.from(''),
        phases: { total_ms: 5 },
      },
    });
    const { summary } = await runProbes(spec, emptyState(), options, deps);
    expect(summary.journeys[0]).toMatchObject({ failure: 'asset', detail: 'asset failed' });
  });

  it('treats a slow warm repeat as slow and opens after two runs', async () => {
    const { deps, sent } = harness({
      ...healthy,
      'https://anime.test/api/search': [
        json({ filteredList: [1] }, 300),
        json({ filteredList: [1] }, 2500),
        json({ filteredList: [1] }, 300),
        json({ filteredList: [1] }, 2600),
      ],
    });
    const first = await runProbes(spec, emptyState(), options, deps);
    expect(first.summary.journeys[1]).toMatchObject({ outcome: 'slow', status: 'healthy' });
    const second = await runProbes(spec, first.state, options, deps);
    expect(second.summary.journeys[1]).toMatchObject({ outcome: 'slow', status: 'degraded' });
    const opened = sent[1]?.find((log) => log.event === 'journey.degraded');
    expect(opened?.props).toMatchObject({ warm_total_ms: 2600, total_ms: 300, journey: 'search' });
  });

  it('does not open product incidents when the vantage itself is offline', async () => {
    const { deps, sent } = harness({});
    const { state, summary } = await runProbes(spec, emptyState(), options, deps);
    expect(summary.vantage_offline).toBe(true);
    expect(state.journeys).toEqual({});
    expect(sent[0]?.map((log) => log.event)).toEqual([
      'probe.result',
      'probe.result',
      'probe.heartbeat',
    ]);
    expect(sent[0]?.[0]?.props.vantage_offline).toBe(true);
  });

  it('keeps undelivered transitions queued, bounded, and retries them with the same ids', async () => {
    const failing = { 'https://anime.test/': { ...html(), status: 500 } };
    const offline = harness(failing, false);
    const revision = await probeDefinitionRevision(spec.journeys[0]!);
    const crowded: ProbeState = {
      ...emptyState(),
      pending: Array.from({ length: MAX_PENDING_LOGS }, (_, index) => ({
        log_id: `old-${index}`,
        timestamp: 1,
        event: 'journey.failed',
        level: 'error' as const,
        title: 't',
        props: { project: 'anime-list', journey: 'home', revision },
      })),
    };
    const first = await runProbes(spec, crowded, options, offline.deps);
    expect(first.summary.delivered).toBe(false);
    expect(first.state.pending).toHaveLength(MAX_PENDING_LOGS);
    expect(first.state.pending.at(-1)?.event).toBe('journey.failed');
    const retry = harness(failing, true);
    const second = await runProbes(spec, first.state, options, retry.deps);
    expect(second.state.pending).toEqual([]);
    expect(retry.sent[0]?.slice(0, MAX_PENDING_LOGS).map((log) => log.log_id)).toEqual(
      first.state.pending.map((log) => log.log_id),
    );
  });
});

describe('cli', () => {
  let server: Server;
  let origin = '';
  let directory = '';
  const received: unknown[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/v1/logs') {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          received.push({ auth: request.headers.authorization, body: JSON.parse(body) });
          response.writeHead(202).end();
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    directory = await mkdtemp(join(tmpdir(), 'app-health-probe-'));
    await writeFile(
      join(directory, 'spec.json'),
      JSON.stringify({
        schema_version: 1,
        journeys: [
          {
            project: 'app-health',
            journey: 'api-health',
            url: `${origin}/v1/health`,
            budget_ms: 1000,
            expect: { json: [{ path: 'ok', equals: true }] },
          },
        ],
      }),
    );
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('parses arguments strictly', () => {
    expect(parseArgs(['--location', 'india-home'])).toMatchObject({
      location: 'india-home',
      intervalSeconds: 300,
      state: undefined,
    });
    expect(() => parseArgs(['--location'])).toThrow('incomplete');
    expect(() => parseArgs(['--bogus', 'x'])).toThrow('unknown');
    expect(() => parseArgs(['--location', 'India Home'])).toThrow('lowercase');
    expect(() => parseArgs(['--location', 'a', '--interval', '5'])).toThrow('interval');
  });

  it('falls back to empty state for missing or foreign files', async () => {
    expect(await readState(undefined)).toEqual(emptyState());
    expect(await readState(join(directory, 'missing.json'))).toEqual(emptyState());
    await writeFile(join(directory, 'foreign.json'), '{"schema_version":9}');
    expect(await readState(join(directory, 'foreign.json'))).toEqual(emptyState());
    await writeFile(join(directory, 'old.json'), '{"schema_version":1,"journeys":{}}');
    expect(await readState(join(directory, 'old.json'))).toEqual(emptyState());
  });

  it('dry-runs without a key and never writes state', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const statePath = join(directory, 'dry', 'state.json');
    try {
      const code = await main(
        ['--location', 'ci', '--config', join(directory, 'spec.json'), '--state', statePath],
        {},
      );
      expect(code).toBe(0);
      const output = JSON.parse(String(write.mock.calls[0]?.[0]));
      expect(output).toMatchObject({ dry_run: true, journeys: [{ outcome: 'ok' }] });
      expect(output.would_send.map((log: ProbeLog) => log.event)).toEqual([
        'probe.result',
        'probe.heartbeat',
      ]);
    } finally {
      write.mockRestore();
    }
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('delivers with a key and persists state atomically', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const statePath = join(directory, 'live', 'state.json');
    try {
      await main(
        ['--location', 'ci', '--config', join(directory, 'spec.json'), '--state', statePath],
        {
          APP_HEALTH_INGEST_KEY: 'ahk_test',
          APP_HEALTH_LOGS_URL: `${origin}/v1/logs`,
        },
      );
    } finally {
      write.mockRestore();
    }
    expect(received).toMatchObject([{ auth: 'Bearer ahk_test', body: { schema_version: 'v1' } }]);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.journeys['app-health/api-health']).toMatchObject({
      status: 'healthy',
      good_streak: 1,
    });
    await writeState(statePath, emptyState());
    expect(await readState(statePath)).toEqual(emptyState());
  });
});

it('resets a changed check incident while retaining unchanged hysteresis and tags results', async () => {
  const single = { ...spec, journeys: [spec.journeys[0]!] };
  const bad = harness({ 'https://anime.test/': { ...html(), status: 503 } }, false);
  const opened = await runProbes(single, emptyState(), options, bad.deps);
  const good = harness({ ...healthy });
  const recovering = await runProbes(single, opened.state, options, good.deps);
  expect(recovering.state.journeys['anime-list/home']!.status).toBe('failing');
  const changed = structuredClone(single);
  changed.journeys[0]!.expect.body_includes = ['root'];
  const reset = await runProbes(changed, opened.state, options, good.deps);
  expect(reset.state.journeys['anime-list/home']!.status).toBe('healthy');
  expect(good.sent.at(-1)!.filter((log) => log.event === 'journey.failed')).toEqual([]);
  expect(reset.state.revisions!['anime-list/home']).not.toBe(
    opened.state.revisions!['anime-list/home'],
  );
  expect(good.sent.at(-1)!.find((log) => log.event === 'probe.result')!.props.revision).toBe(
    reset.state.revisions!['anime-list/home'],
  );
});

it('drops removed check state and queued incidents without resurrecting deleted projects', async () => {
  const bad = harness(
    {
      'https://anime.test/': { ...html(), status: 503 },
      'https://anime.test/api/search': { ...json({}), status: 503 },
    },
    false,
  );
  const opened = await runProbes(spec, emptyState(), options, bad.deps);
  opened.state.pending.push(
    {
      log_id: 'heartbeat',
      timestamp: 1000,
      event: 'probe.heartbeat',
      level: 'debug',
      title: 'heartbeat',
      props: {},
    },
    {
      log_id: 'wrong-heartbeat',
      timestamp: 1000,
      event: 'probe.heartbeat',
      level: 'debug',
      title: 'not a workspace heartbeat',
      props: { project: 'deleted', journey: 'gone' },
    },
  );
  const remaining = { ...spec, journeys: [spec.journeys[0]!] };
  const good = harness({ ...healthy });
  const result = await runProbes(remaining, opened.state, options, good.deps);
  expect(good.sent[0]!.some((log) => log.log_id === 'heartbeat')).toBe(true);
  expect(good.sent[0]!.some((log) => log.log_id === 'wrong-heartbeat')).toBe(false);
  expect(Object.keys(result.state.revisions!)).toEqual(['anime-list/home']);
  expect(Object.keys(result.state.journeys)).toEqual(['anime-list/home']);
  expect(good.sent[0]!.some((log) => log.props.journey === 'search')).toBe(false);
  expect(
    good.sent[0]!.some((log) => log.event === 'journey.failed' && log.props.journey === 'home'),
  ).toBe(true);
});

it.each(['failed', 'ok'] as const)(
  'supersedes legacy unversioned open incidents without trusting old results or forwarding old queued failures: %s',
  async (outcome) => {
    const single = { ...spec, journeys: [spec.journeys[0]!] };
    const legacy: ProbeState = {
      schema_version: 1,
      journeys: {
        'anime-list/home': {
          status: 'failing',
          incident_id: 'legacy-incident',
          opened_at: 10,
          bad_streak: 2,
          good_streak: 0,
        },
      },
      pending: [
        {
          log_id: 'legacy-pending',
          timestamp: 10,
          event: 'journey.failed',
          level: 'error',
          title: 'old',
          props: { project: 'anime-list', journey: 'home' },
        },
      ],
    };
    const run = harness(
      outcome === 'ok' ? healthy : { 'https://anime.test/': { ...html(), status: 503 } },
    );
    const result = await runProbes(single, legacy, options, run.deps);
    expect(run.sent[0]!.some((log) => log.log_id === 'legacy-pending')).toBe(false);
    expect(run.sent[0]!.find((log) => log.event === 'journey.superseded')!.props).toMatchObject({
      incident_id: 'legacy-incident',
      reason: 'definition_unverified',
      transition: 'superseded',
    });
    expect(run.sent[0]!.some((log) => log.event === 'journey.recovered')).toBe(false);
    expect(result.state.journeys['anime-list/home']!.incident_id).not.toBe('legacy-incident');
  },
);
