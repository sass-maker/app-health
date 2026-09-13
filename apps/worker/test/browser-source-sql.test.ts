import { browserReportPlan } from '../src/browser-report-plan.js';
import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  normalizeAnalyticsSource,
  ANALYTICS_SOURCE_HOSTS,
  ANALYTICS_SOURCE_ALIASES,
} from '@app-health/contracts';
import { analyticsSourceFrom, analyticsSourceSql } from '../src/browser-source-sql.js';

describe('analytics source SQL', () => {
  it('matches pure normalization for historical hostname and spoof fixtures', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE sources (blob6 TEXT, blob10 TEXT DEFAULT '')");
    const values = [
      ' reddit.com ',
      'mobile.twitter.com',
      'www.google.com.',
      'evilgoogle.com',
      'evil.example/.reddit.com',
      'https://reddit.com/path',
      '',
      'partner_launch',
      'a!b.reddit.com',
      'a_b.reddit.com',
      'a\nb.reddit.com',
      'unrecognized.reddit.com',
      'old.reddit.com',
      'a@b.reddit.com',
      '\treddit.com',
      'reddit.com' + 'x'.repeat(120),
      'www.google',
      'search.search.yahoo.com',
      'WWW.Reddit.com.',
      ...Object.keys(ANALYTICS_SOURCE_ALIASES),
      ...ANALYTICS_SOURCE_HOSTS.flatMap(([, hosts]) => hosts).flatMap((host) =>
        ['', 'www.', 'm.', 'mobile.', 'old.', 'l.', 'out.', 'news.', 'search.'].flatMap(
          (prefix) => [prefix + host, prefix + host + '.'],
        ),
      ),
    ];
    const insert = db.prepare('INSERT INTO sources (blob6) VALUES (?)');
    for (const value of values) insert.run(value);
    const sql = sqliteAnalyticsSql(
      `SELECT blob6 AS value, ${analyticsSourceSql()} AS normalized ${analyticsSourceFrom('FROM sources')}`,
    );
    expect(sql).not.toMatch(/\bCASE\b/);
    expect(sql.match(/\bSELECT\b/g)).toHaveLength(2);
    let depth = 0;
    let maximumDepth = 0;
    for (const character of sql) {
      if (character === '(') maximumDepth = Math.max(maximumDepth, ++depth);
      if (character === ')') depth--;
    }
    expect(maximumDepth).toBeLessThanOrEqual(12);
    const rows = db.prepare(sql).all() as Array<{
      value: string;
      normalized: string;
    }>;
    expect(rows.map((row) => row.normalized)).toEqual(
      values.map((value) => normalizeAnalyticsSource(value)),
    );
    expect(sql.length).toBeLessThan(10_000);
    db.close();
  });
});

it('keeps complete workspace reports bounded and excludes archived project scope from all queries', () => {
  const ids = Array.from(
    { length: 40 },
    (_, i) => `app-00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  );
  const plan = browserReportPlan('workspace', { range: '24h' }, 1000, 2000, 40, ids);
  for (const sql of plan.sql) {
    expect(sql).toContain(`blob1 IN ('${ids[0]}'`);
    expect(sql.length).toBeLessThan(10_000);
  }
  for (const sql of browserReportPlan('workspace', { range: '24h' }, 1000, 2000, 40, []).sql)
    expect(sql).toContain('1 = 0');
});
