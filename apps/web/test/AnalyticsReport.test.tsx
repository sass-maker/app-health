import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AnalyticsReport } from '../src/AnalyticsReport.js';

const report = {
  from: 1,
  to: 2,
  sampled: false,
  source: 'local' as const,
  series: [{ timestamp: 1, pageviews: 10, events: 0 }],
  pages: [],
  sources: [],
  events: [],
  sessions: 2,
  audience: {
    visitors: 2,
    new_sessions: 1,
    returning_sessions: 1,
    unidentified_sessions: 0,
    channels: [],
    campaigns: [],
    devices: [],
    browsers: [],
    countries: [],
    entry_pages: [],
  },
  previous: { pageviews: 5, events: 0, sessions: 1, visitors: 1 },
};

it('shows the browser-scoped visitor comparison once in the primary metrics row', () => {
  render(
    <AnalyticsReport
      report={report}
      mode="web"
      selected=""
      metric="pageviews"
      range="24h"
      sourceNote="Local"
      active={null}
      totals={{ pageviews: 10, events: 0 }}
      onMetric={vi.fn()}
      onEvent={vi.fn()}
      breakdown="audience"
      onBreakdown={vi.fn()}
    />,
  );

  const visitors = screen.getByText('Visitors', { exact: true });
  const visitorCard = visitors.closest<HTMLElement>('[data-slot="card"]');
  expect(visitorCard).not.toBeNull();
  expect(within(visitorCard!).getByText('Recognized browsers in this period')).toBeVisible();
  expect(within(visitorCard!).getByLabelText('Visitors comparison')).toHaveTextContent(
    '+100% vs previous period',
  );
  expect(screen.getAllByText('Visitors', { exact: true })).toHaveLength(1);
  expect(screen.getAllByText('Recognized browsers in this period')).toHaveLength(1);
  expect(screen.getAllByLabelText('Visitors comparison')).toHaveLength(1);
});
