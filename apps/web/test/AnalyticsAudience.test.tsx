import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AnalyticsAudience } from '../src/AnalyticsAudience.js';

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
    channels: [{ name: 'Direct', count: 10 }],
    campaigns: [],
    devices: [],
    browsers: [],
    countries: [],
    entry_pages: [],
  },
  previous: { pageviews: 5, events: 0, sessions: 1, visitors: 1 },
};

it('uses page views as the ranking denominator and labels identity states', () => {
  render(<AnalyticsAudience report={report} breakdown="audience" />);
  expect(screen.getAllByText('Page views').length).toBeGreaterThan(0);
  expect(screen.getByText('Returning sessions')).toBeTruthy();
  expect(screen.getByText('Unidentified sessions')).toBeTruthy();
  expect(screen.getByText('100.0%')).toBeTruthy();
  expect(screen.queryByText('500.0%')).toBeNull();
  expect(screen.getByText('+1 vs previous')).toBeTruthy();
});
