import { describe, expect, it } from 'vitest';
import { BrowserReportFilter } from '@app-health/contracts';
import { reportWindow } from '../src/browser-report-window.js';
import { localBrowserReport } from '../src/browser-reports.js';

describe('briefing calendar-day drill-down', () => {
  it('uses the half-open completed India day rather than a rolling window', () => {
    const filter = BrowserReportFilter.parse({ date: '2026-09-30', range: '24h' });
    expect(reportWindow(filter, Date.parse('2026-10-01T13:00:00Z'))).toEqual({
      from: Date.parse('2026-09-29T18:30:00Z'),
      to: Date.parse('2026-09-30T18:30:00Z'),
      step: 3_600_000,
    });
  });
  it.each([{ date: '2026-02-30' }, { date: '9999-12-31' }, { date: '2026-09-30', range: '7d' }])(
    'rejects invalid or ambiguous dates %j',
    (filter) => {
      expect(BrowserReportFilter.safeParse(filter).success).toBe(false);
    },
  );
  it('reads the preceding day for comparisons and excludes the exact end boundary', () => {
    const from = Date.parse('2026-09-29T18:30:00Z');
    const batches = [
      {
        workspace: 'ws',
        app_id: 'app',
        environment_id: 'env',
        batch_id: 'batch',
        received_at: from,
        visitor_hash: 'visitor',
        session_hash: 'session',
        events: [from - 1, from, from + 86_400_000].map((timestamp, i) => ({
          event_id: `event-${i}`,
          timestamp,
          type: 'pageview' as const,
          path: '/',
          referrer: '',
        })),
      },
    ];
    const report = localBrowserReport(
      batches,
      BrowserReportFilter.parse({ date: '2026-09-30' }),
      Date.parse('2026-10-01T13:00:00Z'),
    );
    expect(report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(1);
    expect(report.previous?.pageviews).toBe(1);
  });
});
