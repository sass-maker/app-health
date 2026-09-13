import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { normalizeAnalyticsSource } from '@app-health/contracts';
import { analyticsSourceFrom } from '../src/browser-source-sql.js';

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
      ...['reddit.com', 'x.com', 'google.co.in', 'search.yahoo.com'].flatMap((host) =>
        ['', 'www.', 'm.', 'mobile.', 'old.', 'l.', 'out.', 'news.', 'search.'].flatMap(
          (prefix) => [prefix + host, prefix + host + '.'],
        ),
      ),
    ];
    const insert = db.prepare('INSERT INTO sources (blob6) VALUES (?)');
    for (const value of values) insert.run(value);
    const sql = sqliteAnalyticsSql(analyticsSourceFrom('FROM sources'));
    expect(sql).not.toMatch(/\bCASE\b/);
    let depth = 0;
    let maximumDepth = 0;
    for (const character of sql) {
      if (character === '(') maximumDepth = Math.max(maximumDepth, ++depth);
      if (character === ')') depth--;
    }
    expect(maximumDepth).toBeLessThanOrEqual(12);
    const rows = db
      .prepare(`SELECT blob6 AS value, normalized_source AS normalized ${sql}`)
      .all() as Array<{
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
