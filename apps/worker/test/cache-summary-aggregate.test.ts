import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { CacheSummaryAggregate } from '../src/cache-summary-aggregate.js';
import { D1ControlPlane } from '../src/d1-adapter.js';

const END = 1_780_000_000_000;
const START = END - 86_400_000;
const NOW = END + 1_000;

function props(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'worker_executed',
    started_at: START + 1_000,
    ended_at: START + 2_000,
    version: 'a'.repeat(40),
    version_source: 'reader_source',
    hits: 2,
    misses: 1,
    bypasses: 1,
    eligible: 3,
    unknown_hits: 1,
    unknown_misses: 1,
    unknown_bypasses: 0,
    unknown_eligible: 2,
    declared_publisher_hits: 1,
    declared_publisher_misses: 0,
    declared_publisher_bypasses: 1,
    declared_publisher_eligible: 1,
    declared_diagnostic_hits: 0,
    declared_diagnostic_misses: 0,
    declared_diagnostic_bypasses: 0,
    declared_diagnostic_eligible: 0,
    ...overrides,
  };
}

describe('bounded cache summary accumulator', () => {
  it('sums weighted counts, keeps versions and cohorts separate, and reports exclusions', () => {
    const aggregate = new CacheSummaryAggregate(START, END, NOW);
    aggregate.add({ log_id: 'one', timestamp: START + 2_000, source: 'server', props: props() });
    aggregate.add({
      log_id: 'two',
      timestamp: START + 3_000,
      source: 'server',
      props: props({
        started_at: START + 2_000,
        ended_at: START + 3_000,
        version: '0011223344556677',
        version_source: 'cache_build',
        hits: 1,
        misses: 9,
        eligible: 10,
        bypasses: 0,
        unknown_hits: 1,
        unknown_misses: 9,
        unknown_eligible: 10,
        declared_publisher_hits: 0,
        declared_publisher_bypasses: 0,
        declared_publisher_eligible: 0,
      }),
    });
    aggregate.add({ log_id: 'two', timestamp: START + 3_000, source: 'server', props: props() });
    aggregate.add({ log_id: 'bad', timestamp: START + 4_000, source: 'server', props: '{' });
    aggregate.add({
      log_id: 'cross',
      timestamp: START + 5_000,
      source: 'server',
      props: props({ started_at: START - 1 }),
    });
    aggregate.add({
      log_id: 'browser',
      timestamp: START + 6_000,
      source: 'browser',
      props: props(),
    });
    const result = aggregate.result();
    expect(result.totals).toMatchObject({
      hits: 3,
      misses: 10,
      bypasses: 1,
      eligible: 13,
      rows: 2,
    });
    expect(result.totals.eligible_hit_percent).toBeCloseTo(300 / 13);
    expect(result.cohorts.unknown).toMatchObject({ hits: 2, misses: 10, eligible: 12 });
    expect(result.cohorts.declared_publisher).toMatchObject({ hits: 1, eligible: 1 });
    expect(result.versions).toHaveLength(2);
    expect(result.excluded).toEqual({
      malformed: 1,
      cross_boundary: 1,
      other_source: 1,
      duplicate_ids: 1,
    });
    expect(result.earliest_started_at).toBe(START + 1_000);
    expect(result.latest_ended_at).toBe(START + 3_000);
  });

  it('rejects inconsistent cohort totals and exposes retention limits', () => {
    const aggregate = new CacheSummaryAggregate(START - 31 * 86_400_000, START, NOW);
    aggregate.add({
      log_id: 'bad-counts',
      timestamp: START - 1,
      source: 'server',
      props: props({ hits: 999 }),
    });
    expect(aggregate.result()).toMatchObject({
      contributing_rows: 0,
      excluded: { malformed: 1 },
      coverage: { complete_within_retention: false, late_arrivals_possible: true },
    });
  });

  it('does not echo an unexpected version label from owner-authored props', () => {
    const aggregate = new CacheSummaryAggregate(START, END, NOW);
    aggregate.add({
      log_id: 'private-version',
      timestamp: START + 2_000,
      source: 'server',
      props: props({ version: 'user-secret-reference' }),
    });
    expect(aggregate.result().versions[0].version).toBe('other');
  });

  it('includes a zero-duration summary admitted by the producer contract', () => {
    const aggregate = new CacheSummaryAggregate(START, END, NOW);
    aggregate.add({
      log_id: 'instant',
      timestamp: START + 1_000,
      source: 'server',
      props: props({ started_at: START + 1_000, ended_at: START + 1_000 }),
    });
    expect(aggregate.result().contributing_rows).toBe(1);
  });
});

describe('D1 cache summary scan', () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  let db: Awaited<ReturnType<typeof mf.getD1Database>>;

  beforeAll(async () => {
    db = await mf.getD1Database('DB');
    await db
      .prepare(
        `CREATE TABLE log_events (
      log_id TEXT, app_id TEXT, environment_id TEXT, timestamp INTEGER,
      event TEXT, source TEXT, props TEXT,
      PRIMARY KEY (app_id, environment_id, log_id)
    )`,
      )
      .run();
  });
  afterAll(async () => mf.dispose());

  it('sums more than 500 stored rows with exact app, environment, event and time scope', async () => {
    const insert = db.prepare('INSERT OR IGNORE INTO log_events VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let base = 0; base < 620; base += 100) {
      const statements = [];
      for (let index = base; index < Math.min(base + 100, 620); index += 1) {
        statements.push(
          insert.bind(
            `row-${index}`,
            'app-one',
            'prod',
            START + 2_000 + index,
            'web.cache.summary',
            'server',
            JSON.stringify(props()),
          ),
        );
      }
      await db.batch(statements);
    }
    await db.batch([
      insert.bind(
        'wrong-app',
        'app-two',
        'prod',
        START + 2_000,
        'web.cache.summary',
        'server',
        JSON.stringify(props()),
      ),
      insert.bind(
        'wrong-env',
        'app-one',
        'test',
        START + 2_000,
        'web.cache.summary',
        'server',
        JSON.stringify(props()),
      ),
      insert.bind(
        'wrong-event',
        'app-one',
        'prod',
        START + 2_000,
        'other.event',
        'server',
        JSON.stringify(props()),
      ),
      insert.bind(
        'outside-end',
        'app-one',
        'prod',
        END,
        'web.cache.summary',
        'server',
        JSON.stringify(props()),
      ),
      insert.bind(
        'malformed',
        'app-one',
        'prod',
        START + 3_000,
        'web.cache.summary',
        'server',
        '{',
      ),
      insert.bind(
        'cross-boundary',
        'app-one',
        'prod',
        START + 4_000,
        'web.cache.summary',
        'server',
        JSON.stringify(props({ started_at: START - 1 })),
      ),
    ]);
    const result = await new D1ControlPlane(db).aggregateCacheSummary(
      'app-one',
      'prod',
      START,
      END,
      NOW,
    );
    expect(result.contributing_rows).toBe(620);
    expect(result.totals).toMatchObject({ hits: 1240, misses: 620, bypasses: 620, eligible: 1860 });
    expect(result.excluded).toMatchObject({ malformed: 1, cross_boundary: 1, duplicate_ids: 0 });
    expect(result.versions).toHaveLength(1);
  });
});
